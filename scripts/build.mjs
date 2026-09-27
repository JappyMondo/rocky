import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
if (process.version !== "v24.16.0") throw new Error("Use pinned Node 24.16.0");
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
