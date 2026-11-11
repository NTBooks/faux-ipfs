// The IPFS part of Faux IPFS: turn bytes into the same CIDs a real IPFS node gives them, and check bytes against a CID.
//
// IPFS doesn't hash a file in one go. `ipfs add` cuts it into 256 KiB chunks (the leaves), hashes each one, then builds a
// tree of small dag-pb nodes (UnixFS "file" nodes, up to 174 children each) whose links are the children's CIDs. The root
// node's CID is the file's CID. Change one byte anywhere and that leaf's hash changes, so every node above it changes too.
//
// We use the reference JS importer (ipfs-unixfs-importer) for the build so the CIDs match kubo's byte for byte, and keep
// only the small inner nodes. The file itself is stored whole in R2; its leaves are just ranges of that object.
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { UnixFS } from "ipfs-unixfs";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

export const CHUNK = 262144; // kubo's default chunker, size-262144

export type CidVersion = 0 | 1;
// CIDv1 = `ipfs add --cid-version=1` (raw leaves, what hosted pinning services hand out today); CIDv0 = plain `ipfs add` ("Qm..." hashes).
export const importOptions = (v: CidVersion) => ({
  cidVersion: v,
  rawLeaves: v === 1,
  leafType: "file" as const, // a v0 leaf is a dag-pb node holding a UnixFS "file" block, as kubo writes it
  reduceSingleLeafToSelf: true,
  chunker: fixedSize({ chunkSize: CHUNK }),
});

export type Leaf = { cid: string; offset: number; size: number };

/** Hash `content` the way `ipfs add` does. Returns the root CID and the inner (non-leaf) blocks to keep. */
export async function build(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, v: CidVersion) {
  const inner = new Map<string, Uint8Array>();
  let leaves = 0;
  const blockstore = {
    async put(cid: CID, bytes: Uint8Array) {
      if (cid.code === dagPb.code && dagPb.decode(bytes).Links.length > 0) inner.set(cid.toString(), bytes);
      else leaves++;
      return cid;
    },
  };
  let root: CID | undefined;
  let size = 0; // the file's own byte count (the importer's entry.size is the whole DAG, node overhead included)
  const counted = (async function* () { for await (const c of content) { size += c.byteLength; yield c; } })();
  for await (const entry of importer([{ content: counted }], blockstore as never, importOptions(v))) root = entry.cid;
  if (!root) throw new Error("importer produced no root");
  return { root, inner, leaves, size };
}

export type DirFile = { path: string; cid: string; size: number; bytes: Uint8Array };

const isDirNode = (bytes: Uint8Array) => {
  const n = dagPb.decode(bytes);
  if (!n.Data) return false;
  const t = UnixFS.unmarshal(n.Data).type;
  if (t === "hamt-sharded-directory") throw new Error("a folder this large is sharded (HAMT), which isn't supported yet");
  return t === "directory";
};

/** Hash a folder the way `ipfs add -r` does. `files` carry their paths ("site/index.html", "site/img/a.png"); a single
 * shared top folder becomes the root, as with `ipfs add -r site`, otherwise the files are wrapped in an unnamed folder
 * (`ipfs add -r -w`). Returns the root CID, the blocks to keep (folder nodes and inner file nodes) and each file's CID. */
export async function buildDir(files: { path: string; bytes: Uint8Array }[], v: CidVersion) {
  const inner = new Map<string, Uint8Array>();
  const blockstore = {
    async put(cid: CID, bytes: Uint8Array) {
      if (cid.code === dagPb.code && (dagPb.decode(bytes).Links.length > 0 || isDirNode(bytes))) inner.set(cid.toString(), bytes);
      return cid;
    },
  };
  const clean = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^\/+/, "") }));
  if (clean.some((f) => !f.path || f.path.split("/").some((s) => s === "" || s === "." || s === ".."))) throw new Error("bad file path");
  const tops = new Set(clean.map((f) => f.path.split("/")[0]));
  const shared = tops.size === 1 && clean.every((f) => f.path.includes("/")) ? [...tops][0] : null;
  const out: DirFile[] = [];
  let root: CID | undefined;
  const opts = { ...importOptions(v), wrapWithDirectory: !shared };
  for await (const e of importer(clean.map((f) => ({ path: f.path, content: [f.bytes] })), blockstore as never, opts)) {
    const p = e.path ?? "";
    if (shared ? p === shared : p === "") root = e.cid;
    const f = clean.find((x) => x.path === p);
    if (f) out.push({ path: shared ? p.slice(shared.length + 1) : p, cid: e.cid.toString(), size: f.bytes.byteLength, bytes: f.bytes });
  }
  if (!root) throw new Error("importer produced no root folder");
  return { root, inner, files: out, name: shared ?? "" };
}

export type Resolved =
  | { kind: "dir"; cid: CID; links: { name: string; cid: string; tsize: number }[] }
  | { kind: "file"; cid: CID; size: number | null }; // size null: a single-block file, its size is its stored object's

/** Follow `segments` from a folder `root`, hashing every node on the way against the CID that pointed to it. */
export async function resolvePath(root: CID, segments: string[], getInner: (cid: string) => Promise<Uint8Array | null>, verify: boolean): Promise<Resolved | null> {
  let cur = root;
  for (let i = 0; ; i++) {
    const bytes = cur.code === dagPb.code ? await getInner(cur.toString()) : null;
    if (!bytes) return i === segments.length ? { kind: "file", cid: cur, size: null } : null;
    if (verify && !(await matches(cur, bytes))) throw new Error(`block ${cur} does not match its CID`);
    const node = dagPb.decode(bytes);
    const fs = UnixFS.unmarshal(node.Data!);
    if (fs.type !== "directory") {
      if (i !== segments.length) return null; // can't walk into a file
      return { kind: "file", cid: cur, size: Number(fs.fileSize()) };
    }
    if (i === segments.length) return { kind: "dir", cid: cur, links: node.Links.map((l) => ({ name: l.Name ?? "", cid: l.Hash.toString(), tsize: l.Tsize ?? 0 })) };
    const link = node.Links.find((l) => l.Name === segments[i]);
    if (!link) return null;
    cur = link.Hash;
  }
}

/** Rebuild a leaf block from its bytes, so the leaf can be checked without storing it separately. */
export async function leafBlock(cid: CID, bytes: Uint8Array): Promise<Uint8Array> {
  if (cid.code === raw.code) return bytes;
  // v0 leaf: a dag-pb node with no links whose Data is UnixFS {type: file, data: bytes}
  const data = new UnixFS({ type: "file", data: bytes }).marshal();
  return dagPb.encode(dagPb.prepare({ Data: data, Links: [] }));
}

/** Does `block` hash to `cid`? (sha2-256 only, which is all `ipfs add` uses by default.) */
export async function matches(cid: CID, block: Uint8Array): Promise<boolean> {
  if (cid.multihash.code !== sha256.code) throw new Error(`unsupported hash 0x${cid.multihash.code.toString(16)}`);
  const d = await sha256.digest(block);
  const a = d.digest, b = cid.multihash.digest;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Walk a file's tree from the root and list its leaves in order, with each leaf's byte range in the file.
 * `getInner` fetches an inner node by CID; with `verify`, every inner node is hashed against its CID first, so the
 * leaf list is proven to belong to the root the caller asked for. */
export async function leavesOf(root: CID, size: number, getInner: (cid: string) => Promise<Uint8Array | null>, verify: boolean): Promise<Leaf[]> {
  const out: Leaf[] = [];
  let offset = 0;
  const walk = async (cid: CID, dataSize: number) => {
    const bytes = cid.code === dagPb.code ? await getInner(cid.toString()) : null;
    if (!bytes) { out.push({ cid: cid.toString(), offset, size: dataSize }); offset += dataSize; return; } // a leaf
    if (verify && !(await matches(cid, bytes))) throw new Error(`inner block ${cid} does not match its CID`);
    const node = dagPb.decode(bytes);
    const fs = UnixFS.unmarshal(node.Data!);
    const sizes = fs.blockSizes.map(Number);
    if (sizes.length !== node.Links.length) throw new Error(`malformed node ${cid}`);
    for (let i = 0; i < node.Links.length; i++) await walk(node.Links[i].Hash, sizes[i]);
  };
  await walk(root, size);
  if (offset !== size) throw new Error(`tree covers ${offset} bytes, file is ${size}`);
  return out;
}

export const parseCid = (s: string): CID | null => { try { return CID.parse(s); } catch { return null; } };
