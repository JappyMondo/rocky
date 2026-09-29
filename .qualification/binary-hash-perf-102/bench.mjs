// #102 item 2 measurement: old (readFileSync whole-file buffer + sha256) vs
// new (chunked synchronous sha256, shipped as dist/runner/process.js
// measureBinaryIdentity). The old implementation is replicated inline here for
// comparison only; it is not kept in src. Big temp files are created ONLY
// under the pre-approved temp dir and deleted after measuring.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir, totalmem, cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { measureBinaryIdentity } from "../../dist/runner/process.js";

const N = 5;
const SIZE = 225 * 1024 * 1024; // ~225 MB, exactly 235,929,600 bytes
const SMALL = 4 * 1024; // few-KB scale, like the fake CLI used in tests
const TMP =
  process.argv[2] ??
  "/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/binary-hash-perf-102";

/** Old implementation, byte-for-byte the pre-#102 measureBinaryIdentity. */
function measureOld(path) {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new Error("binary-identity-missing");
  if (lstatSync(path).isSymbolicLink())
    throw new Error("binary-identity-drift");
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("binary-identity-missing");
  const bytes = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function genFile(path, sizeBytes, kind) {
  const CHUNK = 4 * 1024 * 1024;
  const buf = kind === "random" ? randomBytes(CHUNK) : Buffer.alloc(CHUNK);
  const fd = openSync(path, "w");
  try {
    for (let written = 0; written < sizeBytes; ) {
      const n = Math.min(CHUNK, sizeBytes - written);
      writeSync(fd, buf, 0, n);
      written += n;
    }
  } finally {
    closeSync(fd);
  }
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
  };
};

function bench(label, fn) {
  const ms = [];
  const rss = [];
  let last;
  for (let i = 0; i < N; i++) {
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    last = fn();
    ms.push(performance.now() - t0);
    rss.push(process.memoryUsage().rss - rss0);
  }
  const t = stats(ms);
  const r = stats(rss);
  console.log(
    `${label}\n` +
      `  ms      min=${t.min.toFixed(1)} median=${t.median.toFixed(1)} max=${t.max.toFixed(1)}\n` +
      `  rssMB   min=${(r.min / 1048576).toFixed(1)} median=${(r.median / 1048576).toFixed(1)} max=${(r.max / 1048576).toFixed(1)}\n` +
      `  runs    [${ms.map((x) => x.toFixed(1)).join(", ")}]\n` +
      `  result  sha256=${last.sha256} bytes=${last.bytes}`,
  );
  return last;
}

console.log("== environment ==");
console.log(`node    ${process.version} (${process.platform} ${process.arch})`);
console.log(`cpus    ${cpus().length}x ${cpus()[0]?.model?.trim() ?? "?"}`);
console.log(`memGB   ${(totalmem() / 1073741824).toFixed(1)}`);
console.log(`tmpdir  ${tmpdir()}`);
console.log(`workdir ${TMP}`);
console.log(
  "note    measurements on this dev machine (macOS); the real qualification environment may differ\n",
);

mkdirSync(TMP, { recursive: true });
const smallPath = `${TMP}/small-fake-cli`;
const cases = [
  { name: "small-4KiB-random", path: smallPath, size: SMALL, kind: "random" },
  { name: "225MB-zero-filled", path: `${TMP}/big-zero`, size: SIZE, kind: "zero" },
  { name: "225MB-random", path: `${TMP}/big-random`, size: SIZE, kind: "random" },
];

try {
  for (const c of cases) {
    console.log(`== ${c.name} (${c.size} bytes, ${c.kind}) ==`);
    genFile(c.path, c.size, c.kind);
    const oldR = bench(`old readFileSync+sha256 [${c.name}]`, () => measureOld(c.path));
    const newR = bench(`new chunked sha256      [${c.name}]`, () => measureBinaryIdentity(c.path));
    if (oldR.sha256 !== newR.sha256 || oldR.bytes !== newR.bytes)
      throw new Error(`MISMATCH ${c.name}: ${JSON.stringify({ oldR, newR })}`);
    console.log(`  parity  old==new sha256/bytes OK\n`);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
  console.log(`cleanup: deleted ${TMP} (225MB files never enter the repo)`);
  console.log(`peak process rssMB ${(process.memoryUsage().peakRss ?? process.memoryUsage().rss) / 1048576}`);
}
