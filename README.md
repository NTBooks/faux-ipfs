# Faux IPFS

A private IPFS gateway emulated on Cloudflare: **one Worker, one R2 bucket, one KV namespace, no IPFS node.**

**Live demo: [ipfs.slopscore.org](https://ipfs.slopscore.org)** (type some text, get its CID) · [API spec](https://ipfs.slopscore.org/api) ·
[an example folder](https://ipfs.slopscore.org/ipfs/bafybeiaolvzzicjh6cayzr7rz2lggnvrqvyljokslynrkexbl72mtpwswm/)

You upload a file or a folder, it gets the **same CID a real IPFS node would give it** (checked against kubo, the
reference implementation, from 0 bytes to 100 MB, nested folders, CIDv0 and CIDv1), and `GET /ipfs/<cid>` (or
`/ipfs/<cid>/path/in/folder`) serves it back the way an IPFS gateway does, **checking the bytes against the CID as
they stream**. Add `?verify=false` to pass the bytes straight through instead.

The question it answers: how much of a hosted IPFS pinning service is really "IPFS", and how much is a file server
with hash indexing? Running a node becomes optional: you keep the content addressing and the verifiability, and
drop the node.

## What an IPFS gateway is

IPFS names a file by what it contains, not where it lives. `ipfs add` cuts the file into 256 KiB chunks, hashes each
one, and builds a small tree (a Merkle DAG) of nodes that link to those hashes. The root's hash, wrapped as a **CID**,
is the file's address: change one byte and the CID changes.

A **gateway** is the HTTP front door to that: `GET https://gateway/ipfs/<cid>` returns the bytes
([path gateway spec](https://specs.ipfs.tech/http-gateways/path-gateway/)), with immutable caching (a CID's content
can never change), ranges, `?filename=`, `?download=true`, and `?format=raw` for clients that verify blocks
themselves ([trustless gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/)).

A **private** (or "dedicated") gateway is one a pinning service runs for you: it serves only your pinned content by
default, and can be opened to others with a gateway token (`?pinataGatewayToken=` or `x-pinata-gateway-token` on the
best-known service; this project accepts those names and its own `gatewayToken` / `x-gateway-token`).

Behind a hosted gateway sits an IPFS node that stores the blocks and announces them to the public network. Faux IPFS
keeps the parts you actually use day to day (content addressing, verifiable reads, a private gateway, an API) and
replaces the node with object storage.

## How it works

| Piece | Cloudflare part | What it holds |
|---|---|---|
| The gateway and the API | a Worker (`src/index.ts`) | routing, auth, hashing, verification |
| The files | R2, `files/<cid>` | each file, whole (so pass-through reads and ranges come straight from R2) |
| Folders' files | R2, `dirs/<folder cid>/<file cid>` | each file in a folder, whole, once per distinct content |
| The tree | R2, `blocks/<cid>/<inner cid>` | inner DAG nodes and folder nodes: a few KB even for a 100 MB file |
| The pins | KV, `pin:<cid>` | name, size, type, CID version, created, keyvalues |

**Upload** (`src/dag.ts`): the bytes go through the reference JS importer (`ipfs-unixfs-importer`) with kubo's
settings: 256 KiB chunks, balanced tree, 174 links per node, raw leaves for CIDv1, UnixFS file leaves for CIDv0. Only
the inner nodes are kept; the leaves are just ranges of the stored file.

**Verified read** (the default): the Worker fetches the root node and every inner node, hashes each one against its
CID, and walks them to get the ordered list of leaf CIDs, so the leaf list is proven to belong to the CID you asked
for. Then it streams the file from R2 a run of leaves at a time, hashing each 256 KiB leaf (re-wrapped as its block for
CIDv0) against its leaf CID before sending it. A range request only checks the leaves it touches.
If a leaf doesn't match, the stream stops there: bytes from that leaf onward are never sent. The response headers
have already gone out by then, so the client sees a cut-off response; locally, `wrangler dev` turns a stream that
fails before its first byte into a 500.

**Folders** work the same way, one level up. A folder is a UnixFS directory node whose named links point at its files
and subfolders; its CID is the hash of that node, so it covers every name and every byte inside. Upload a folder as
several `file` parts whose filenames carry the path (`site/index.html`, `site/img/a.png`) and it gets the CID
`ipfs add -r site` would give it (files with no shared top folder are wrapped, like `ipfs add -w`). Reading
`/ipfs/<folder>/img/a.png` walks from the folder's node down the path, hashing each folder node against the CID that
pointed to it, then serves the file exactly as above. A folder URL redirects to its slash form and serves the folder's
`index.html` if it has one, or a listing. As on a restricted hosted gateway, a file inside a folder is reached through
the folder's CID, not its own.

**Pass-through read** (`?verify=false`, or `X-Faux-Verify: false`, or `VERIFY_DEFAULT = "false"`): the R2 object is
streamed as is, ranges and all, with no hashing. The `X-Faux-Verify` response header says `verified` or `skipped`.

The tests prove both: `test/smoke.sh` flips one bit in a stored file, and the verified read refuses it while
`?verify=false` serves the bad bytes.

**The edge cache.** A CID's bytes never change, so verified gateway responses go into Cloudflare's cache (the Workers
Cache API) and stay there (`Cache-Control: immutable`). The next read in that data center is served from the cache:
no R2 read, no hashing. Every gateway response says `X-Faux-Cache: HIT` or `MISS`.
- **The order matters.** The gateway token and the pin lookup (one KV read) run *before* the cache. A private gateway
  stays private, and a deleted pin is 404 at once even while a copy is still cached.
- **Only verified responses are stored.** If verification fails mid-stream, the copy being stored fails with it and
  nothing is cached. A pass-through (`?verify=false`) miss is never stored. So a hit is always bytes that were checked
  against the CID, and a `?verify=false` request that hits gets that checked copy (labelled `verified`).
- **Ranges** are answered as 206 from the cached copy when the cache slices it. In production the cache sometimes
  hands back the whole file for a Range request instead; that hit is skipped and the range is served from R2, which
  verifies only the chunks it touches. The cache key is the path plus the only parameters that change the response
  (`filename`, `download`, `format`); tokens and `verify` don't split it.
- **Limits:** the cache is per data center (each one fills on its first read there). It works on a custom domain. It
  isn't available to Workers behind Cloudflare Access (see below), and it does nothing in the dashboard editor. When
  it isn't available, the gateway runs uncached. `CACHE = "false"` turns it off.

## API

The full spec is served at **`/api`** (and as OpenAPI at `/api/openapi.json`). It's linked from the homepage.

**Owner only** (`Authorization: Bearer <OWNER_TOKEN>`): without the secret set, the owner API doesn't open at all.

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/files` | upload (multipart `file`, optional `name`, `cidVersion`, `keyvalues`; or a raw body with `?name=`). Several `file` parts with paths in their filenames upload a folder |
| `GET` | `/api/files` | list (`?limit=`, `?cursor=`) |
| `GET` | `/api/files/<cid>` | one record |
| `PATCH` | `/api/files/<cid>` | rename or add keyvalues (the CID never changes) |
| `DELETE` | `/api/files/<cid>` | unpin and delete a file or folder, with everything stored for it |

Legacy pinning-API aliases, so existing SDK calls can point here by changing the base URL:
`POST /pinning/pinFileToIPFS`, `POST /pinning/pinJSONToIPFS`, `DELETE /pinning/unpin/<cid>`, `GET /data/pinList`,
`GET /data/testAuthentication`. They take the same field names (`pinataMetadata`, `pinataOptions.cidVersion`) and
answer `{IpfsHash, PinSize, Timestamp, isDuplicate}`.

**Gateway**: `GET|HEAD /ipfs/<cid>` and `/ipfs/<folder cid>/<path>` with `?verify=false`, `?download=true`,
`?filename=`, `?format=raw`, `Range`. Open by default (it can only ever serve what's pinned here); set `GATEWAY_TOKEN`
to require a token.

```bash
curl -H "Authorization: Bearer $OWNER_TOKEN" -F file=@photo.jpg https://your-gateway/api/files
curl https://your-gateway/ipfs/bafkrei...                  # verified
curl "https://your-gateway/ipfs/bafkrei...?verify=false"    # pass-through

# a folder: one file part per file, the path in the filename
curl -H "Authorization: Bearer $OWNER_TOKEN" \
  -F "file=@site/index.html;filename=site/index.html" -F "file=@site/img/a.png;filename=site/img/a.png" \
  https://your-gateway/api/files
curl https://your-gateway/ipfs/bafybei.../img/a.png
```

## The demo

Set `DEMO = "true"` and the homepage becomes a text box: type something, press **Hash it and pin it**, and the text is
pinned (CIDv1, as `demo.txt`, tagged `demo: true`). You get its CID and gateway links.

**For this demo only simple input is allowed:** up to 5,000 characters of English letters (`A-Z`, `a-z`), numbers
(`0-9`), spaces, new lines and simple punctuation (`. , ! ? ' " - : ; ( )`). The page checks as you type, and
`POST /demo/pin` enforces the same rules on the server (`src/demo.ts`), so `< > & / \` and anything non-English are
refused whatever the browser sends. Demo pins are served as `text/plain`.

The demo is the only thing anyone can write without the owner token, so put a rate limit on it (below) before you
leave it on.

## Controlling access with Cloudflare Access and the WAF

The tokens above are enough on their own, but because the Worker sits on Cloudflare you can put the platform's own
access controls in front of it without changing any code.

**Cloudflare Access** (Zero Trust, free for up to 50 users): add a *self-hosted application* for the gateway's
hostname.
- Protect the owner paths (`/api/files*`, `/pinning/*`, `/data/*`) with a policy that allows only you (your email,
  your identity provider, a device posture check). Scripts and CI get an Access **service token** and send
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers alongside the bearer token, so the owner API now needs
  two keys.
- To make the files themselves private (a gateway only your team can read), add `/ipfs/*` to the application with a
  policy for the people allowed to read. They sign in once and get a cookie; nothing in the Worker changes.
- Leave `/`, `/api` (the spec page) and `/demo/*` outside the application, or bypass them, if the demo should stay public.
- Access works on a custom domain, and on `*.workers.dev` with the Worker's Access setting turned on.
- **Access turns off the edge cache.** Cloudflare's docs: "For Workers fronted by Cloudflare Access, the Cache API is not
  currently available." Putting only the owner paths behind Access keeps public reads cached. Putting `/ipfs/*` behind
  it makes every read go to R2 and be verified again; that works, it just costs more R2 reads and CPU.

**WAF custom rules** (Security → WAF on the zone):
- Block the owner paths from everywhere except your IPs or countries:
  `(starts_with(http.request.uri.path, "/api/files") or starts_with(http.request.uri.path, "/pinning/")) and not ip.src in $my_ips` → Block.
- Allow only the methods you use: block anything that isn't `GET`, `HEAD`, `POST`, `PATCH`, `DELETE` or `OPTIONS`.
- Restrict reads by country, ASN or referrer if the files are meant for one site (a hotlink guard).
- **Rate limiting rules**: cap `POST /demo/pin` per IP (say 10 a minute) and `/api/files` uploads; cap `/ipfs/*`
  reads per IP if you're worried about one client hammering verified reads (they cost CPU time).
- Turnstile or a managed challenge on `/demo/pin` if bots find it.

A request that Access or the WAF blocks never reaches the Worker, so it costs nothing in Worker requests or CPU time.

## Costs (November 11, 2026)

Prices from Cloudflare's published rates and the public pricing pages of two hosted IPFS pinning services on
2026-11-11. They change; check before deciding.

**Faux IPFS on Cloudflare** needs the Workers Paid plan ($5/month): the free plan allows 10 ms of CPU per request,
which isn't enough to hash an upload. Inside that $5: 10 M requests, 30 M CPU-ms, and KV's 10 M reads, 1 M writes
and 1 GB. R2 storage is $0.015/GB-month after 10 GB free, operations $4.50 per million writes and $0.36 per million
reads after the free 1 M / 10 M, and **egress is free**.

The hosted plans compared ("Service A" and "Service B") are typical of IPFS pinning services with a dedicated gateway:
- **Service A, entry plan:** $20/month for 1 TB stored, 500 GB of bandwidth and 1 M requests. After that, $0.07/GB
  stored, $0.10/GB of bandwidth and $0.20 per 10k requests.
- **Service A, mid plan:** $100/month for 5 TB stored, 2.5 TB of bandwidth and 5 M requests. After that, $0.035/GB,
  $0.08/GB and $0.15 per 10k.
- **Service B:** $7.50/month for 500 GB stored and 250 GB of bandwidth, then $0.015/GB for each.

Monthly cost for four workloads (reads assume ~3 R2 reads and 1 KV read each, verification on, and **no cache hits**,
so these are the most it would cost):

| Workload | Faux IPFS | Service A entry | Service A mid | Service B |
|---|---|---|---|---|
| Hobby: 1 GB stored, 10 GB served, 10k reads | **$5.00** | $0 (free tier) | $100 | $0 (free tier) |
| Small: 100 GB stored, 500 GB served, 1 M reads | **$6.35** | $20 | $100 | $11.25 |
| Medium: 1 TB stored, 2 TB served, 5 M reads | **$21.65** | $250 | $100 | $41.25 |
| Heavy: 1 TB stored, 10 TB served, 20 M reads | **$45.85** | $1,350 | $925 | $161.25 |

How the Faux IPFS numbers add up:
- **Small:** $5 + 90 GB of storage ($1.35). Everything else fits in the plan.
- **Medium:** $5 + 990 GB of storage ($14.85) + 5 M R2 reads over the free tier ($1.80).
- **Heavy:** adds 50 M R2 reads ($18), 10 M KV reads ($5) and 10 M Worker requests ($3).

Hashing for verification is SHA-256, at about 2 s of CPU per GB served, so even 10 TB fits in the plan's 30 M CPU-ms.
Turning verification off (`?verify=false`) drops that CPU time to near zero. With the edge cache, a hit costs one
Worker request and one KV read: no R2 reads and no hashing. Popular files get much cheaper than the table shows; the
storage line doesn't change.

**Where the gap comes from:** almost entirely bandwidth. Hosted gateways charge $0.08-0.10/GB served past the plan;
R2 charges nothing for egress. For small, mostly idle collections a free tier beats the $5 minimum.

## What it took

About 1,000 lines including tests, written with Claude Code. The first version (single files, the API, the demo, this
README) took 26 minutes from an empty folder to the first commit; folders took about 10 more, and the edge cache
about 10 after that.
- `src/dag.ts` (150 lines): kubo-identical CIDs for files and folders, path resolution, leaf rebuilding, tree verification.
- `src/index.ts` (420): the gateway, folders, the owner API, the legacy aliases.
- `src/spec.ts` (110): the API spec page and OpenAPI document.
- `src/demo.ts` (80): the demo page and its server-side rules.
- `test/` (250): the kubo comparisons for files and folders, and the end-to-end script.

The hard part of IPFS (chunking and the DAG) is a well-maintained library. The rest is a file server with hash
indexing.

## What it doesn't do (yet)

- **It isn't on the IPFS network.** No DHT announcements and no bitswap, so `ipfs.io` and other nodes can't fetch
  your content from it. That's the "node optional" trade. To publish to the public network as well, pin the same
  bytes to any IPFS node; the CID will match.
- **Very large folders.** A folder with thousands of entries in one directory gets sharded by IPFS (a HAMT); those are
  refused for now. Folders upload in one request, so the size limit below covers the whole folder.
- **No IPNS** (mutable names): every address here is a fixed CID.
- **`format=raw` serves the block at the requested path only** (a file's root, a folder's node). Arbitrary inner and
  leaf blocks by their own CID, and `format=car`, aren't there yet; both are straightforward from what's stored.
- **Upload size.** Workers take request bodies up to 100 MB on the Free and Pro plans (200 MB Business, 500 MB
  Enterprise), and the upload is held in memory (128 MB) while it's hashed. Bigger files would need direct multipart
  uploads to R2 and hashing in a Queue consumer.
- **Hash functions.** sha2-256 only (what `ipfs add` uses by default); no blake3 or other multihashes.

## Setup

```bash
npm install
npx wrangler r2 bucket create faux-ipfs
npx wrangler kv namespace create PINS          # paste the id into wrangler.toml
npx wrangler secret put OWNER_TOKEN            # a long random string
npx wrangler secret put GATEWAY_TOKEN          # optional: make reads need a token
npx wrangler deploy
```

Local: put `OWNER_TOKEN=...` in `.dev.vars`, then `npx wrangler dev --port 8799 --local --var DEMO:true`.

## Tests

- `npm test`: hashes 10 file sizes with this code and with kubo (`ipfs add --only-hash`, from the `kubo` npm package)
  for CIDv0 and CIDv1, and checks every leaf can be rebuilt and verified (all 20 match). Then a nested folder with a
  multi-chunk file, a duplicate and an empty file against `ipfs add -r`, plus loose files against `ipfs add -w`, and
  resolves every path with every node verified.
- `bash test/smoke.sh`: against a running dev server on empty storage. Uploads files and a folder, kubo comparison,
  verified and pass-through reads, ranges, HEAD, folder redirects, `index.html` and listings, `format=raw` (checked by
  kubo's `block put`), owner-only access, the legacy aliases, the demo's rules, the edge cache (hits, ranges, keys,
  nothing unverified stored, deletes), tampering, delete. 68 checks.
