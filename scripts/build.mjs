import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  rmSync,
  existsSync,
  cpSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
if (process.version !== "v24.16.0") throw new Error("Use pinned Node 24.16.0");
// An active adapter invokes supervisor.js lazily: replacing dist mid-run can strand it.
const activeRoot = ".qualification/attraccess/active-runtimes";
if (existsSync(activeRoot))
  for (const file of readdirSync(activeRoot)) {
    const marker = JSON.parse(readFileSync(join(activeRoot, file)));
    let fingerprint;
    try {
      fingerprint = execFileSync(
        "/bin/ps",
        ["-p", String(marker.process?.pid), "-o", "lstart=", "-o", "command="],
        { encoding: "utf8", timeout: 1000 },
      ).trim();
    } catch {
      continue;
    }
    if (fingerprint === marker.process?.fingerprint)
      throw new Error(
        "active-environment-runtime-build-refused:" + marker.attempt,
      );
  }
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
    .length > 0;
rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], {
  stdio: "inherit",
});
cpSync("src/web", "dist/web", { recursive: true });
const hashes = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else
      hashes[path] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
  }
}
walk("dist");
const identity = {
  schema: 1,
  sourceCommit: sha,
  sourceDirty: dirty,
  node: process.version,
  packageVersion: JSON.parse(readFileSync("package.json")).version,
  files: hashes,
};
identity.buildId = createHash("sha256")
  .update(JSON.stringify(identity))
  .digest("hex");
writeFileSync(
  "dist/build-identity.json",
  JSON.stringify(identity, null, 2) + "\n",
);
chmodSync("dist/cli.js", 0o755);
console.log(
  JSON.stringify({
    sourceCommit: sha,
    sourceDirty: dirty,
    buildId: identity.buildId,
  }),
);
