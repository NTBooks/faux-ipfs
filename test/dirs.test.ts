// Folders: do our folder CIDs match `ipfs add -r` (kubo), for CIDv0 and CIDv1, with nested folders, an empty file,
// a multi-chunk file and a file repeated under two names? And does path resolution reach every file, verified?
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { buildDir, resolvePath, leavesOf, leafBlock, matches, type CidVersion } from "../src/dag.ts";
import { CID } from "multiformats/cid";

const require = createRequire(import.meta.url);
const kubo: string = require("kubo").path();
const repo = mkdtempSync(join(tmpdir(), "faux-ipfs-kubo-"));
const env = { ...process.env, IPFS_PATH: repo };
execFileSync(kubo, ["init", "--profile", "test", "-e"], { env, stdio: "ignore" });

const enc = new TextEncoder();
const big = new Uint8Array(700000).map((_, i) => (i * 31 + 7) & 255);
const files = [
  { path: "site/index.html", bytes: enc.encode("<h1>hi</h1>") },
  { path: "site/notes.txt", bytes: enc.encode("same slime, same nuggets") },
  { path: "site/copy-of-notes.txt", bytes: enc.encode("same slime, same nuggets") },
  { path: "site/empty.txt", bytes: new Uint8Array(0) },
  { path: "site/img/big.bin", bytes: big },
  { path: "site/img/deeper/x.json", bytes: enc.encode('{"a":1}') },
];
const dir = mkdtempSync(join(tmpdir(), "faux-ipfs-dir-"));
for (const f of files) { mkdirSync(join(dir, dirname(f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.bytes); }

let fail = 0;
for (const v of [1, 0] as CidVersion[]) {
  const want = execFileSync(kubo, ["add", "-r", "-Q", `--cid-version=${v}`, join(dir, "site")], { env }).toString().trim();
  const { root, inner, files: out } = await buildDir(files, v);
  const ok = root.toString() === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} v${v} folder ${root}${ok ? "" : `  kubo: ${want}`}`);
  // every file reachable by path, every node verified, every leaf checks out
  for (const f of out) {
    const r = await resolvePath(root, f.path.split("/"), async (c) => inner.get(c) ?? null, true);
    let good = !!r && r.kind === "file" && r.cid.toString() === f.cid;
    if (good && r && r.kind === "file") {
      const size = r.size ?? f.size;
      const leaves = await leavesOf(r.cid, size, async (c) => inner.get(c) ?? null, true);
      for (const l of leaves) { const c = CID.parse(l.cid); if (!(await matches(c, await leafBlock(c, f.bytes.subarray(l.offset, l.offset + l.size))))) good = false; }
    }
    if (!good) fail++;
    console.log(`${good ? "ok  " : "FAIL"}    /${f.path}`);
  }
  const missing = await resolvePath(root, ["nope.txt"], async (c) => inner.get(c) ?? null, true);
  if (missing !== null) { fail++; console.log("FAIL    missing path should not resolve"); }
  const sub = await resolvePath(root, ["img"], async (c) => inner.get(c) ?? null, true);
  if (sub?.kind !== "dir") { fail++; console.log("FAIL    /img should be a folder"); } else console.log(`ok      /img is a folder with ${sub.links.length} entries`);
}
// files with no shared top folder get wrapped, like `ipfs add -w`
const loose = [{ path: "a.txt", bytes: enc.encode("a") }, { path: "b.txt", bytes: enc.encode("b") }];
mkdirSync(join(dir, "loose")); for (const f of loose) writeFileSync(join(dir, "loose", f.path), f.bytes);
const wantW = execFileSync(kubo, ["add", "-Q", "-w", "--cid-version=1", join(dir, "loose", "a.txt"), join(dir, "loose", "b.txt")], { env }).toString().trim();
const w = await buildDir(loose, 1);
if (w.root.toString() !== wantW) fail++;
console.log(`${w.root.toString() === wantW ? "ok  " : "FAIL"} v1 wrapped loose files ${w.root}`);

rmSync(dir, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "folders match kubo");
process.exit(fail ? 1 : 0);
