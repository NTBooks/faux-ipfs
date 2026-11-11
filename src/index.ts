// Faux IPFS: a private IPFS gateway on one Cloudflare Worker, an R2 bucket and a KV namespace. No IPFS node.
//
//   Owner API (Authorization: Bearer <OWNER_TOKEN>)        Gateway (open, or GATEWAY_TOKEN when set)
//   POST   /api/files            upload, returns the CID    GET|HEAD /ipfs/<cid>   ?verify=false  ?download=true
//   GET    /api/files            list                                             ?filename=x    ?format=raw
//   GET    /api/files/<cid>      one record                                       Range requests
//   PATCH  /api/files/<cid>      rename / keyvalues
//   DELETE /api/files/<cid>      delete
//   Legacy pinning-API aliases: /pinning/pinFileToIPFS, /pinning/pinJSONToIPFS, /pinning/unpin/<cid>, /data/pinList,
//   /data/testAuthentication (so existing pinning-SDK calls can point here).
//
// Storage: R2 files/<cid> = the file, whole; R2 blocks/<cid>/<inner cid> = the file's inner DAG nodes (a few KB);
// KV pin:<cid> = the record (name, size, type, created, keyvalues).
import { build, buildDir, resolvePath, leavesOf, leafBlock, matches, parseCid, type CidVersion, type Leaf } from "./dag";
import type { CID } from "multiformats/cid";
import { apiPage, openapi } from "./spec";
import { demoPage, demoText, homePage } from "./demo";

export interface Env {
  FILES: R2Bucket;
  PINS: KVNamespace;
  OWNER_TOKEN: string;        // secret: wrangler secret put OWNER_TOKEN
  GATEWAY_TOKEN?: string;     // optional secret: when set, gateway reads need it (or the owner token)
  VERIFY_DEFAULT?: string;    // "true" (default) or "false": verify served bytes against the CID unless ?verify= says otherwise
  DEFAULT_CID_VERSION?: string; // "1" (default, what hosted pinning services hand out today) or "0"
  DEMO?: string;              // "true": the homepage is the public text-pinning demo, and POST /demo/pin exists
  CACHE?: string;             // "true" (default) or "false": keep verified gateway responses in Cloudflare's edge cache
}

type Pin = {
  cid: string; name: string; size: number; type: string; cidVersion: CidVersion;
  created: string; keyvalues: Record<string, string>; inner: string[];
  kind?: "file" | "dir";   // "dir": a folder; its files are R2 dirs/<cid>/<file cid>
  files?: number;          // folders: how many files
  objects?: string[];      // folders: the file CIDs stored under dirs/<cid>/
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const err = (status: number, message: string) => json({ error: message }, status);

// ---------------------------------------------------------------- auth
const enc = new TextEncoder();
async function same(a: string, b: string) { // constant-time compare via HMAC of both sides
  const k = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([crypto.subtle.sign("HMAC", k, enc.encode(a)), crypto.subtle.sign("HMAC", k, enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
async function isOwner(req: Request, env: Env) {
  if (!env.OWNER_TOKEN) return false; // never open by accident: no secret, no owner API
  return same(bearer(req), env.OWNER_TOKEN);
}
async function canRead(req: Request, url: URL, env: Env) {
  if (!env.GATEWAY_TOKEN) return true;
  const t = url.searchParams.get("gatewayToken") ?? url.searchParams.get("pinataGatewayToken")
    ?? req.headers.get("x-gateway-token") ?? req.headers.get("x-pinata-gateway-token");
  if (t && (await same(t, env.GATEWAY_TOKEN))) return true;
  return isOwner(req, env);
}

// ---------------------------------------------------------------- content types
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  json: "application/json", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", pdf: "application/pdf", mp4: "video/mp4",
  webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", zip: "application/zip", csv: "text/csv",
};
const typeFor = (name: string, given?: string | null) =>
  (given && given !== "application/octet-stream" ? given : TYPES[name.split(".").pop()?.toLowerCase() ?? ""]) ?? "application/octet-stream";

// ---------------------------------------------------------------- upload
async function* streamChunks(s: ReadableStream<Uint8Array>) {
  const r = s.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) return; yield value; }
}
async function pin(env: Env, blob: Blob, name: string, type: string, v: CidVersion, keyvalues: Record<string, string>) {
  const { root, inner, size } = await build(streamChunks(blob.stream()), v);
  const cid = root.toString();
  const existing = await env.PINS.get<Pin>(`pin:${cid}`, "json");
  if (existing) return { pin: existing, isDuplicate: true };
  await env.FILES.put(`files/${cid}`, blob, { httpMetadata: { contentType: type } });
  await Promise.all([...inner].map(([c, bytes]) => env.FILES.put(`blocks/${cid}/${c}`, bytes)));
  const p: Pin = { cid, name, size, type, cidVersion: v, created: new Date().toISOString(), keyvalues, inner: [...inner.keys()] };
  await putPin(env, p);
  return { pin: p, isDuplicate: false };
}
const putPin = (env: Env, p: Pin) =>
  env.PINS.put(`pin:${p.cid}`, JSON.stringify(p), { metadata: { name: p.name.slice(0, 200), size: p.size, created: p.created, kind: p.kind ?? "file" } });

/** A folder: every file with its path ("site/index.html"). Gets the CID `ipfs add -r` would give the folder. */
async function pinDir(env: Env, files: File[], name: string | null, v: CidVersion, keyvalues: Record<string, string>) {
  const items = await Promise.all(files.map(async (f) => ({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const { root, inner, files: out, name: top } = await buildDir(items, v);
  const cid = root.toString();
  const existing = await env.PINS.get<Pin>(`pin:${cid}`, "json");
  if (existing) return { pin: existing, isDuplicate: true };
  const unique = new Map(out.map((f) => [f.cid, f]));
  await Promise.all([...unique.values()].map((f) => env.FILES.put(`dirs/${cid}/${f.cid}`, f.bytes, { httpMetadata: { contentType: typeFor(f.path) } })));
  await Promise.all([...inner].map(([c, bytes]) => env.FILES.put(`blocks/${cid}/${c}`, bytes)));
  const p: Pin = {
    cid, name: name || top || "folder", size: out.reduce((s, f) => s + f.size, 0), type: "inode/directory", cidVersion: v,
    created: new Date().toISOString(), keyvalues, inner: [...inner.keys()], kind: "dir", files: out.length, objects: [...unique.keys()],
  };
  await putPin(env, p);
  return { pin: p, isDuplicate: false };
}

const cidVersionOf = (env: Env, s?: string | null): CidVersion => ((s ?? env.DEFAULT_CID_VERSION ?? "1") === "0" ? 0 : 1);
const parseJson = <T,>(s: string | File | null | undefined, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

async function upload(req: Request, url: URL, env: Env) {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!files.length) return { error: "multipart field 'file' is required" } as const;
    // our fields (name, cidVersion, keyvalues) or the legacy pinning API's (pinataMetadata, pinataOptions)
    const meta = parseJson<{ name?: string; keyvalues?: Record<string, string> }>(form.get("pinataMetadata"), {});
    const opts = parseJson<{ cidVersion?: number }>(form.get("pinataOptions"), {});
    const kv = parseJson<Record<string, string>>(form.get("keyvalues"), meta.keyvalues ?? {});
    const v = cidVersionOf(env, (form.get("cidVersion") as string) ?? (opts.cidVersion !== undefined ? String(opts.cidVersion) : null));
    // a folder: several files, or a filename with a path in it ("site/index.html"), the same convention the legacy API uses
    if (files.length > 1 || files.some((f) => f.name.includes("/"))) {
      try { return await pinDir(env, files, (form.get("name") as string) || meta.name || null, v, kv); }
      catch (e) { return { error: (e as Error).message } as const; }
    }
    const file = files[0];
    const name = (form.get("name") as string) || meta.name || file.name || "file";
    return pin(env, file, name, typeFor(name, file.type), v, kv);
  }
  // a raw body: POST /api/files?name=report.pdf&cidVersion=1
  const blob = await req.blob();
  const name = url.searchParams.get("name") || "file";
  return pin(env, blob, name, typeFor(name, ct), cidVersionOf(env, url.searchParams.get("cidVersion")), parseJson(url.searchParams.get("keyvalues"), {}));
}

async function remove(env: Env, cid: string) {
  const p = await env.PINS.get<Pin>(`pin:${cid}`, "json");
  if (!p) return false;
  const keys = [p.kind === "dir" ? null : `files/${cid}`, ...(p.objects ?? []).map((c) => `dirs/${cid}/${c}`), ...p.inner.map((c) => `blocks/${cid}/${c}`)]
    .filter((k): k is string => !!k);
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000)); // R2 deletes up to 1000 keys a call
  await env.PINS.delete(`pin:${cid}`);
  return true;
}

async function list(env: Env, url: URL) {
  const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 100) || 100);
  const r = await env.PINS.list<{ name: string; size: number; created: string }>({ prefix: "pin:", limit, cursor: url.searchParams.get("cursor") ?? undefined });
  return { files: r.keys.map((k) => ({ cid: k.name.slice(4), ...k.metadata })), cursor: r.list_complete ? null : r.cursor };
}
const pub = (p: Pin) => ({
  cid: p.cid, kind: p.kind ?? "file", name: p.name, size: p.size, type: p.type, cidVersion: p.cidVersion, created: p.created,
  keyvalues: p.keyvalues, ...(p.kind === "dir" ? { files: p.files } : {}), url: `/ipfs/${p.cid}${p.kind === "dir" ? "/" : ""}`,
});

// ---------------------------------------------------------------- gateway
const IMMUTABLE = "public, max-age=29030400, immutable";

/** Bytes [start, end) of the file, read from R2 a leaf at a time and each leaf hashed against its CID before it is sent. */
function verifiedBody(env: Env, objKey: string, leaves: Leaf[], start: number, end: number): ReadableStream<Uint8Array> {
  const need = leaves.filter((l) => l.offset + l.size > start && l.offset < end);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (i >= need.length) { ctl.close(); return; }
      // read a run of up to 16 leaves (4 MiB) per R2 request, then check them one by one
      const run = need.slice(i, i + 16);
      const from = run[0].offset, to = run[run.length - 1].offset + run[run.length - 1].size;
      const obj = await env.FILES.get(objKey, { range: { offset: from, length: to - from } });
      if (!obj) { ctl.error(new Error("file missing from storage")); return; }
      const buf = new Uint8Array(await obj.arrayBuffer());
      for (const l of run) {
        const bytes = buf.subarray(l.offset - from, l.offset - from + l.size);
        const leaf = parseCid(l.cid)!;
        if (!(await matches(leaf, await leafBlock(leaf, bytes)))) {
          // the stored bytes are not the bytes this CID names: stop rather than serve them
          ctl.error(new Error(`leaf ${l.cid} at byte ${l.offset} failed verification`));
          return;
        }
        const a = Math.max(start, l.offset) - l.offset, b = Math.min(end, l.offset + l.size) - l.offset;
        if (b > a) ctl.enqueue(bytes.subarray(a, b));
      }
      i += run.length;
    },
  });
}

function parseRange(h: string | null, size: number): [number, number] | null | "bad" {
  if (!h) return null;
  const m = h.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let s: number, e: number;
  if (m[1] === "") { s = Math.max(0, size - Number(m[2])); e = size; }
  else { s = Number(m[1]); e = m[2] === "" ? size : Math.min(size, Number(m[2]) + 1); }
  return s >= e || s >= size ? "bad" : [s, e];
}

const asciiName = (n: string) => n.replace(/[^\x20-\x7e]|["\\]/g, "_");
const disposition = (kind: string, n: string) => `${kind}; filename="${asciiName(n)}"; filename*=UTF-8''${encodeURIComponent(n)}`;

type Target = {
  fileCid: CID; objKey: string; blockPrefix: string; size: number; name: string; type: string;
};

const readBlock = (env: Env, prefix: string) => async (c: string) => {
  const o = await env.FILES.get(prefix + c);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
};

/** One block by CID, from the stored inner blocks or rebuilt from a single-block file's bytes, checked against its CID. */
async function rawBlock(env: Env, cid: CID, blockPrefix: string, objKey: string | null): Promise<Uint8Array | null> {
  let block: Uint8Array | null = await readBlock(env, blockPrefix)(cid.toString());
  if (!block && objKey) {
    const obj = await env.FILES.get(objKey);
    if (obj) block = await leafBlock(cid, new Uint8Array(await obj.arrayBuffer()));
  }
  return block && (await matches(cid, block)) ? block : null;
}

/** Serve one file (a single-file pin, or a file inside a folder), verified or passed through, with ranges and HEAD. */
async function serveFile(req: Request, url: URL, env: Env, t: Target, verify: boolean, headers: Headers) {
  const name = url.searchParams.get("filename") ?? t.name;
  headers.set("content-type", typeFor(name, t.type));
  headers.set("content-disposition", disposition(url.searchParams.get("download") === "true" ? "attachment" : "inline", name));
  headers.set("accept-ranges", "bytes");
  const range = parseRange(req.headers.get("range"), t.size);
  if (range === "bad") return new Response(null, { status: 416, headers: { "content-range": `bytes */${t.size}` } });
  const [start, end] = range ?? [0, t.size];
  headers.set("content-length", String(end - start));
  const status = range ? 206 : 200;
  if (range) { headers.set("content-range", `bytes ${start}-${end - 1}/${t.size}`); headers.set("etag", `"${t.fileCid}.${start}-${end - 1}"`); }
  if (req.method === "HEAD" || t.size === 0) return new Response(null, { status, headers });

  if (!verify) { // pass-through: straight from R2, no hashing
    const obj = await env.FILES.get(t.objKey, range ? { range: { offset: start, length: end - start } } : undefined);
    if (!obj) return err(500, "file missing from storage");
    return new Response(obj.body, { status, headers });
  }
  // verified: prove the tree under the file's CID first (every inner node hashed), then stream leaf by leaf
  let leaves: Leaf[];
  try { leaves = await leavesOf(t.fileCid, t.size, readBlock(env, t.blockPrefix), true); }
  catch (e) { return err(500, `verification failed: ${(e as Error).message}`); }
  return new Response(verifiedBody(env, t.objKey, leaves, start, end), { status, headers });
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

function listing(cid: string, path: string, links: { name: string; cid: string; tsize: number }[]) {
  const rows = links.map((l) => `<tr><td><a href="./${encodeURIComponent(l.name)}">${escHtml(l.name)}</a></td><td><code>${escHtml(l.cid)}</code></td><td>${l.tsize.toLocaleString("en")}</td></tr>`).join("");
  const up = path ? `<p><a href="../">..</a></p>` : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>/ipfs/${escHtml(cid)}/${escHtml(path)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}td{padding:4px 14px 4px 0;border-top:1px solid #ddd;vertical-align:top}code{font-size:12px;word-break:break-all}</style>
<h2>/ipfs/<code>${escHtml(cid)}</code>/${escHtml(path)}</h2>${up}<table><tr><th align=left>Name</th><th align=left>CID</th><th align=left>Size (DAG)</th></tr>${rows}</table>`;
}

// ---------------------------------------------------------------- edge cache
// A CID's bytes never change, so a verified response can sit in Cloudflare's cache for good (Cache-Control: immutable).
// The cache is checked AFTER the gateway token and the pin lookup: a deleted pin 404s at once even while a copy is still
// cached, and a private gateway stays private. Only verified responses are stored, so a hit is already-checked bytes;
// if verification fails mid-stream, the copy being stored errors too and nothing is cached. Ranges are answered (206)
// from the full cached copy. The cache is per data center, needs a custom domain, and isn't available to Workers
// behind Cloudflare Access: every cache call is wrapped so the gateway just runs uncached there.
const KEEP_PARAMS = ["filename", "download", "format"]; // the only query params that change the response
const cacheOn = (env: Env) => (env.CACHE ?? "true") !== "false";
function cacheKey(url: URL, range: string | null) {
  const k = new URL(url.origin + url.pathname);
  for (const n of KEEP_PARAMS) { const v = url.searchParams.get(n); if (v !== null) k.searchParams.set(n, v); }
  return new Request(k.toString(), { method: "GET", headers: range ? { range } : {} });
}
const withHeader = (r: Response, name: string, value: string, body: BodyInit | null = r.body) => {
  const h = new Headers(r.headers); h.set(name, value);
  return new Response(body, { status: r.status, statusText: r.statusText, headers: h });
};

async function gateway(req: Request, url: URL, env: Env, ctx: ExecutionContext, cidStr: string, rest: string) {
  if (!(await canRead(req, url, env))) return err(401, "gateway token required");
  const root = parseCid(cidStr);
  if (!root) return err(400, "not a valid CID");
  // like a restricted dedicated gateway: only content pinned here is served (there is no network to fetch from), and a
  // file inside a folder is reached through the folder's CID plus its path
  const p = await env.PINS.get<Pin>(`pin:${root}`, "json");
  if (!p) return err(404, "not pinned on this gateway");
  if (!cacheOn(env)) return gatewayServe(req, url, env, root, rest, p);

  const cache = (caches as unknown as { default: Cache }).default;
  const range = req.headers.get("range");
  try {
    const hit = await cache.match(cacheKey(url, range));
    // a range answered with the whole cached file (seen in production: 200, not 206) would send every byte for a
    // 100-byte request; skip that hit and serve the range from R2, which verifies only the chunks it touches
    if (hit && !(range && hit.status !== 206)) {
      const inm = req.headers.get("if-none-match");
      if (inm && inm === hit.headers.get("etag")) return new Response(null, { status: 304, headers: { etag: inm, "x-faux-cache": "HIT" } });
      return withHeader(hit, "x-faux-cache", "HIT", req.method === "HEAD" ? null : hit.body);
    }
  } catch { /* no cache here (behind Access, a preview): serve uncached */ }

  const res = await gatewayServe(req, url, env, root, rest, p);
  const storable = req.method === "GET" && !range && res.status === 200 && res.body && res.headers.get("x-faux-verify") === "verified";
  if (!storable) return withHeader(res, "x-faux-cache", "MISS");
  const [mine, theirs] = res.body!.tee();
  const toCache = new Response(theirs, { status: 200, headers: res.headers });
  ctx.waitUntil(cache.put(cacheKey(url, null), toCache).catch(() => { /* failed verification, too big, or no cache: skip */ }));
  return withHeader(res, "x-faux-cache", "MISS", mine);
}

async function gatewayServe(req: Request, url: URL, env: Env, root: CID, rest: string, p: Pin) {
  const cid = root.toString();

  const verifyParam = url.searchParams.get("verify") ?? req.headers.get("x-faux-verify");
  const verify = (verifyParam ?? env.VERIFY_DEFAULT ?? "true") !== "false";
  const format = url.searchParams.get("format") ?? (req.headers.get("accept")?.includes("application/vnd.ipld.raw") ? "raw" : null);
  if (format && format !== "raw") return err(501, `format=${format} is not supported (raw only)`);
  const blockPrefix = `blocks/${cid}/`;
  let segments: string[];
  try { segments = rest.split("/").filter(Boolean).map(decodeURIComponent); } catch { return err(400, "bad path"); }
  const headers = new Headers({
    "cache-control": IMMUTABLE, "x-ipfs-roots": cid, "access-control-allow-origin": "*",
    "x-faux-verify": verify ? "verified" : "skipped",
  });
  // set the per-path headers; true when the client already has this version (304)
  const finish = (pathCid: string, ipfsPath: string) => {
    headers.set("etag", `"${pathCid}${format === "raw" ? ".raw" : ""}"`);
    headers.set("x-ipfs-path", ipfsPath); headers.set("ipfs-uri", `ipfs://${ipfsPath.slice(6)}`);
    if (pathCid !== cid) headers.set("x-ipfs-roots", `${cid},${pathCid}`);
    return req.headers.get("if-none-match") === headers.get("etag");
  };
  const raw = async (target: CID, objKey: string | null) => {
    const block = await rawBlock(env, target, blockPrefix, objKey);
    if (!block) return err(500, "stored block failed verification");
    headers.set("content-type", "application/vnd.ipld.raw"); headers.set("x-content-type-options", "nosniff");
    headers.set("content-disposition", disposition("attachment", `${target}.bin`));
    return new Response(req.method === "HEAD" ? null : (block as Uint8Array<ArrayBuffer>), { headers });
  };
  const fileIn = async (fileCid: CID, knownSize: number | null, name: string, path: string) => {
    const objKey = `dirs/${cid}/${fileCid}`;
    if (finish(fileCid.toString(), path)) return new Response(null, { status: 304, headers });
    if (format === "raw") return raw(fileCid, objKey);
    let size = knownSize;
    if (size === null) { const h = await env.FILES.head(objKey); if (!h) return err(500, "file missing from storage"); size = h.size; }
    return serveFile(req, url, env, { fileCid, objKey, blockPrefix, size, name, type: typeFor(name) }, verify, headers);
  };

  if (p.kind !== "dir") { // ---- a single file
    if (segments.length) return err(404, "this CID is a file, not a folder");
    if (finish(cid, `/ipfs/${cid}`)) return new Response(null, { status: 304, headers });
    if (format === "raw") return raw(root, `files/${cid}`);
    return serveFile(req, url, env, { fileCid: root, objKey: `files/${cid}`, blockPrefix, size: p.size, name: p.name, type: p.type }, verify, headers);
  }

  // ---- a folder: walk the path, hashing every folder node on the way (or not, with ?verify=false)
  let r;
  try { r = await resolvePath(root, segments, readBlock(env, blockPrefix), verify); }
  catch (e) { return err(500, `verification failed: ${(e as Error).message}`); }
  if (!r) return err(404, `no such path in this folder: /${segments.join("/")}`);
  const sub = segments.join("/");
  if (r.kind === "file") return fileIn(r.cid, r.size, segments[segments.length - 1] ?? p.name, `/ipfs/${cid}/${sub}`);

  // a folder URL ends in a slash, like any gateway, so the relative links in its pages work
  if (!rest.endsWith("/")) {
    return new Response(null, { status: 301, headers: { location: `/ipfs/${cid}${sub ? "/" + segments.map(encodeURIComponent).join("/") : ""}/${url.search}` } });
  }
  const ipfsPath = `/ipfs/${cid}/${sub ? sub + "/" : ""}`;
  if (format === "raw") { finish(r.cid.toString(), ipfsPath); return raw(r.cid, null); }
  if (r.links.some((l) => l.name === "index.html")) { // serve the folder's index.html, as gateways do
    const ir = await resolvePath(r.cid, ["index.html"], readBlock(env, blockPrefix), verify).catch(() => null);
    if (ir && ir.kind === "file") return fileIn(ir.cid, ir.size, "index.html", `${ipfsPath}index.html`);
  }
  if (finish(r.cid.toString(), ipfsPath)) return new Response(null, { status: 304, headers });
  headers.set("etag", `"DirIndex-${r.cid}"`); headers.set("content-type", "text/html; charset=utf-8");
  return new Response(req.method === "HEAD" ? null : listing(cid, sub ? sub + "/" : "", r.links), { headers });
}

// ---------------------------------------------------------------- router
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = path.match(/^\/ipfs\/([^/]+)(\/.*)?$/);
    if (m && (req.method === "GET" || req.method === "HEAD")) return gateway(req, url, env, ctx, m[1], m[2] ?? "");
    const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" } });
    const demo = ["true", "1", "yes", "on"].includes(String(env.DEMO ?? "").trim().toLowerCase());
    if (path === "/" && req.method === "GET") return html(demo ? demoPage() : homePage());
    if ((path === "/api" || path === "/api/") && req.method === "GET") return html(apiPage(url.origin));
    if (path === "/api/openapi.json" && req.method === "GET") return json(openapi(url.origin), 200, { "access-control-allow-origin": "*" });
    if (path === "/demo/pin" && req.method === "POST") {
      if (!demo) return err(404, "not found");
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      const t = demoText(body?.text);
      if ("error" in t) return err(400, t.error);
      const blob = new Blob([t.text], { type: "text/plain; charset=utf-8" });
      const r = await pin(env, blob, "demo.txt", "text/plain; charset=utf-8", 1, { demo: "true" });
      return json({ cid: r.pin.cid, url: `/ipfs/${r.pin.cid}`, size: r.pin.size, isDuplicate: r.isDuplicate }, r.isDuplicate ? 200 : 201);
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, range, x-gateway-token, x-pinata-gateway-token", "access-control-allow-methods": "GET, HEAD, POST, PATCH, DELETE" } });

    // everything below is the owner's
    const api = path.startsWith("/api/") || path.startsWith("/pinning/") || path.startsWith("/data/");
    if (!api) return err(404, "not found");
    if (!(await isOwner(req, env))) return err(401, "owner token required (Authorization: Bearer ...)");

    try {
      // ---- the simple API
      if (path === "/api/files" && req.method === "POST") {
        const r = await upload(req, url, env);
        if ("error" in r) return err(400, r.error as string);
        return json({ ...pub(r.pin), isDuplicate: r.isDuplicate }, r.isDuplicate ? 200 : 201);
      }
      if (path === "/api/files" && req.method === "GET") return json(await list(env, url));
      const f = path.match(/^\/api\/files\/([^/]+)$/);
      if (f) {
        const c = parseCid(f[1])?.toString();
        if (!c) return err(400, "not a valid CID");
        if (req.method === "DELETE") return (await remove(env, c)) ? json({ deleted: c }) : err(404, "not pinned");
        const p = await env.PINS.get<Pin>(`pin:${c}`, "json");
        if (!p) return err(404, "not pinned");
        if (req.method === "GET") return json(pub(p));
        if (req.method === "PATCH") {
          const b = (await req.json().catch(() => ({}))) as { name?: string; keyvalues?: Record<string, string> };
          if (typeof b.name === "string") p.name = b.name;
          if (b.keyvalues && typeof b.keyvalues === "object") p.keyvalues = { ...p.keyvalues, ...b.keyvalues };
          await putPin(env, p);
          return json(pub(p));
        }
      }
      if (path === "/api/whoami") return json({ owner: true });

      // ---- legacy pinning-API aliases
      if (path === "/pinning/pinFileToIPFS" && req.method === "POST") {
        const r = await upload(req, url, env);
        if ("error" in r) return err(400, r.error as string);
        return json({ IpfsHash: r.pin.cid, PinSize: r.pin.size, Timestamp: r.pin.created, isDuplicate: r.isDuplicate });
      }
      if (path === "/pinning/pinJSONToIPFS" && req.method === "POST") {
        const b = (await req.json()) as { pinataContent?: unknown; pinataMetadata?: { name?: string; keyvalues?: Record<string, string> }; pinataOptions?: { cidVersion?: number } };
        const name = b.pinataMetadata?.name ?? "data.json";
        const blob = new Blob([JSON.stringify(b.pinataContent ?? b)], { type: "application/json" });
        const r = await pin(env, blob, name, "application/json", cidVersionOf(env, b.pinataOptions?.cidVersion?.toString()), b.pinataMetadata?.keyvalues ?? {});
        return json({ IpfsHash: r.pin.cid, PinSize: r.pin.size, Timestamp: r.pin.created, isDuplicate: r.isDuplicate });
      }
      const u = path.match(/^\/pinning\/unpin\/([^/]+)$/);
      if (u && req.method === "DELETE") {
        const c = parseCid(u[1])?.toString();
        return c && (await remove(env, c)) ? new Response("OK") : err(404, "not pinned");
      }
      if (path === "/data/pinList" && req.method === "GET") {
        const l = await list(env, url);
        return json({ count: l.files.length, rows: l.files.map((x) => ({ ipfs_pin_hash: x.cid, size: x.size, date_pinned: x.created, metadata: { name: x.name } })) });
      }
      if (path === "/data/testAuthentication") return json({ message: "Authenticated with Faux IPFS" });
      return err(404, "not found");
    } catch (e) {
      return err(500, (e as Error).message);
    }
  },
};

export type { CID };
