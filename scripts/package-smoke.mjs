import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = resolve(
  ".qualification/package-smoke",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(root, { recursive: true });
const source = JSON.parse(readFileSync("dist/build-identity.json"));
assert.equal(
  source.sourceDirty,
  false,
  "Package smoke requires committed clean source",
);
assert.equal(
  source.sourceCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
const packed = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { encoding: "utf8" },
  ),
);
const tarball = join(root, packed[0].filename);
const prefix = join(root, "installation");
mkdirSync(prefix);
const install = execFileSync(
  "npm",
  [
    "install",
    "--prefix",
    prefix,
    "--cache",
    join(root, "npm-cache"),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    tarball,
  ],
  { encoding: "utf8" },
);
writeFileSync(join(root, "install.log"), install);
const command = join(prefix, "node_modules/.bin/rocky-next");
const installed = JSON.parse(
  execFileSync(command, ["identity"], {
    cwd: prefix,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  }),
);
assert.deepEqual(installed, source);
const packageRoot = join(prefix, "node_modules/@jappymondo/rocky-next");
for (const [file, expected] of Object.entries(installed.files))
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(packageRoot, file)))
      .digest("hex"),
    expected,
  );
const probe = join(prefix, "probe.mjs");
writeFileSync(
  probe,
  `import { Store } from '@jappymondo/rocky-next';
const s=new Store('./smoke.sqlite');
s.admit({id:'installed',head:'H',base:'B',scope:'S',versions:{workflow:'1',adapter:'1',prompt:'1',runner:'1',build:'${installed.buildId}'}});
console.log(JSON.stringify(s.get('installed')));s.close();
`,
);
const admission = JSON.parse(
  execFileSync(process.execPath, [probe], { cwd: prefix, encoding: "utf8" }),
);
assert.equal(admission.id, "installed");
const config = JSON.parse(
  execFileSync(command, ["config"], {
    cwd: prefix,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SYNTHETIC_TOKEN: "SYNTHETIC-SECRET-DO-NOT-LOG",
    },
  }),
);
assert.equal(
  JSON.stringify(config).includes("SYNTHETIC-SECRET-DO-NOT-LOG"),
  false,
);
const result = {
  sourceCommit: installed.sourceCommit,
  buildId: installed.buildId,
  packageSha256: createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex"),
  tarball,
  prefix,
  installedIdentity: installed,
  config,
  admission,
  secretAbsent: true,
  qualification: "local-package-only",
};
writeFileSync(
  join(root, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    root,
    sourceCommit: result.sourceCommit,
    buildId: result.buildId,
    packageSha256: result.packageSha256,
  }),
);
