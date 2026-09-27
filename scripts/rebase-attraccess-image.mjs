// Source-preserving image preparation for the exact approved fixture. No target edits.
import { load, runtime } from "./attraccess-runtime.mjs";
import { mkdirSync, readFileSync, writeFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { OwnedProbes } = await load("attraccess/probes.js");
const { materialize, inventoryProbe } = await load("attraccess/source.js");
const { TARGET, LIMITS } = await load("attraccess/policy.js");
const { digest, canonical } = await load("store/json.js");
const { runtimeIntegrity } = await load("attraccess/integrity.js");
const priorPath = process.argv[2];
if (!priorPath) throw Error("accepted-prior-proposed-inputs-required");
const prior = JSON.parse(readFileSync(priorPath));
assert.equal(prior.targetCommit, TARGET.provenance.originalCommit);
assert.equal(
  digest(canonical(prior.prepared.sourceInventory)),
  TARGET.provenance.originalInventorySha256,
);
const id =
  "fixture-image-" + new Date().toISOString().replace(/[^A-Za-z0-9-]/g, "-");
const root = join(TARGET.root, id);
mkdirSync(root, { mode: 0o700 });
const c = new EnvironmentCommands(root, id),
  probes = new OwnedProbes(c);
const outcome = {
  id,
  scope: "unscored-fixture-image-preparation",
  runtime,
  runtimeIntegrity: runtimeIntegrity(),
  status: "running",
  startedAt: new Date().toISOString(),
  priorPath,
};
c.save("attempt", outcome);
try {
  const disk = statfsSync(TARGET.root);
  assert.ok(disk.bavail * disk.bsize >= LIMITS.diskMinimumBytes);
  const context = join(root, "context");
  mkdirSync(context, { mode: 0o700 });
  const copied = materialize(join(context, "source"));
  c.save("source-inventory", copied);
  const changed = Object.keys(copied.inventory).filter(
    (k) =>
      canonical(copied.inventory[k]) !==
      canonical(prior.prepared.sourceInventory[k]),
  );
  assert.deepEqual(changed, [TARGET.provenance.changedFile]);
  // Every dependency/toolchain input is in the unchanged complement of the full inventory.
  const verify = async (image, inventory, commit, tree, label) => {
    const inv = join(root, label + "-inventory.json"),
      script = join(root, label + "-probe.cjs");
    writeFileSync(inv, JSON.stringify(inventory), { mode: 0o600 });
    writeFileSync(
      script,
      inventoryProbe("/probe.json") +
        `const cp=require('child_process');const git=cp.execFileSync('git',['rev-parse','HEAD','HEAD^{tree}','--show-toplevel'],{cwd:'/app',encoding:'utf8'}).trim();if(git!==${JSON.stringify(commit + "\n" + tree + "\n/app")})throw Error('image-git-drift');if(cp.execFileSync('git',['branch','--show-current'],{cwd:'/app',encoding:'utf8'}).trim())throw Error('image-branch');console.log(git);`,
      { mode: 0o600 },
    );
    const result = await probes.run(
      image,
      [
        "bash",
        "-c",
        "node --version && pnpm --version && sha256sum /usr/local/bin/node /usr/local/bin/pnpm /usr/bin/zip && node /source-probe.cjs",
      ],
      [
        "--mount",
        "type=bind,src=" + inv + ",dst=/probe.json,readonly",
        "--mount",
        "type=bind,src=" + script + ",dst=/source-probe.cjs,readonly",
      ],
      30000,
    );
    assert.ok(
      result.stdout.includes("v" + TARGET.node) &&
        result.stdout.includes(TARGET.pnpm),
    );
    c.save(label + "-verified", { image, stdout: result.stdout });
    return result.stdout;
  };
  const before = await verify(
    prior.prepared.devImage,
    prior.prepared.sourceInventory,
    TARGET.provenance.originalCommit,
    TARGET.provenance.originalTree,
    "parent-image",
  );
  const image = "rocky-next-env:" + id;
  const recipe = `FROM ${prior.prepared.devImage}\nCOPY source/ /app/\n`;
  const recipePath = join(context, "Dockerfile.fixture");
  writeFileSync(recipePath, recipe);
  writeFileSync(
    join(context, ".dockerignore"),
    "source/node_modules\nsource/.nx\nsource/dist\nsource/storage\nsource/.env\n",
  );
  c.save("recipe", {
    image,
    baseImage: prior.prepared.devImage,
    recipeSha256: digest(recipe),
    sourceCommit: TARGET.commit,
    sourceTree: TARGET.tree,
    changedSourceFiles: changed,
    dependencyToolchainInputsUnchanged: true,
  });
  await c.dockerCommand([
    "build",
    "--label",
    "rocky-next.owner=" + id,
    "--tag",
    image,
    "--file",
    recipePath,
    context,
  ]);
  const built = await c.inspectImage(image);
  const after = await verify(
    built.Id,
    copied.inventory,
    TARGET.commit,
    TARGET.tree,
    "fixture-image",
  );
  assert.deepEqual(
    after.split("\n").slice(0, 5),
    before.split("\n").slice(0, 5),
  );
  Object.assign(outcome, {
    status: "prepared-images",
    devImage: built.Id,
    mailpitImage: prior.prepared.mailpitImage,
    sourceInventorySha256: copied.inventorySha256,
    sourceCommit: TARGET.commit,
    sourceTree: TARGET.tree,
    recipeSha256: digest(recipe),
    toolchainAndSource: after,
    provenance: TARGET.provenance,
  });
} catch (error) {
  outcome.status = "failed";
  outcome.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    outcome.cleanup = await probes.close();
  } catch (error) {
    outcome.status = "failed";
    outcome.cleanupError = error.message;
    process.exitCode = 1;
  }
  outcome.finishedAt = new Date().toISOString();
  c.save("attempt", outcome);
  if (outcome.status === "prepared-images") c.save("prepared-images", outcome);
  c.close();
  console.log(
    JSON.stringify({
      root,
      status: outcome.status,
      error: outcome.error,
      devImage: outcome.devImage,
      cleanup: outcome.cleanup?.status,
    }),
  );
}
