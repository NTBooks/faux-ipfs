// Do our CIDs match a real IPFS node's? Runs kubo (the reference implementation, from the `kubo` npm package) with
// `ipfs add --only-hash` on the same bytes and compares, for CIDv0 and CIDv1, across the sizes where tree shapes change:
// empty, tiny, exactly one chunk, one chunk + 1 byte, one full level (174 chunks) +/- 1, and two levels.
// Then checks that every leaf can be rebuilt from its byte range and verified (what the gateway does when serving).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { CID } from "multiformats/cid";
import { build, leavesOf, leafBlock, matches, CHUNK, type CidVersion } from "../src/dag.ts";

const require = createRequire(import.meta.url);
const kubo: string = require("kubo").path();
const repo = mkdtempSync(join(tmpdir(), "faux-ipfs-kubo-"));
const env = { ...process.env, IPFS_PATH: repo };
execFileSync(kubo, ["init", "--profile", "test", "-e"], { env, stdio: "ignore" });

const kuboCid = (file: string, v: CidVersion) =>
  execFileSync(kubo, ["add", "--only-hash", "-Q", `--cid-version=${v}`, file], { env }).toString().trim();

const bytesOf = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
  return b;
};
const sizes = [0, 11, 1000, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 7, 174 * CHUNK, 174 * CHUNK + 1, 400 * CHUNK + 12345];

let fail = 0;
const dir = mkdtempSync(join(tmpdir(), "faux-ipfs-files-"));
for (const n of sizes) {
  const data = n === 11 ? new TextEncoder().encode("hello world") : bytesOf(n, n + 7);
  const file = join(dir, `f${n}`);
  writeFileSync(file, data);
  for (const v of [0, 1] as CidVersion[]) {
    const want = kuboCid(file, v);
    const { root, inner, size } = await build([data], v);
    const got = root.toString();
    const ok = got === want;
    // the gateway's check: walk the tree from the stored inner blocks, rebuild each leaf from its range, hash it
    let leavesOk = true, leafCount = 0;
    try {
      const leaves = await leavesOf(root, size, async (c) => inner.get(c) ?? null, true);
      leafCount = leaves.length;
      for (const l of leaves) {
        const cid = CID.parse(l.cid);
        if (!(await matches(cid, await leafBlock(cid, data.subarray(l.offset, l.offset + l.size))))) { leavesOk = false; break; }
      }
    } catch (e) { leavesOk = false; console.log("   ", (e as Error).message); }
    if (!ok || !leavesOk) fail++;
    console.log(`${ok && leavesOk ? "ok  " : "FAIL"} v${v} ${String(n).padStart(9)} B  ${got}${ok ? "" : `  kubo: ${want}`}  leaves ${leafCount}${leavesOk ? "" : " (leaf check FAILED)"}`);
  }
}
rmSync(dir, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "all match kubo");
process.exit(fail ? 1 : 0);
