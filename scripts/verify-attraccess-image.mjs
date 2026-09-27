import { load } from "./attraccess-runtime.mjs";
const { OwnedProbes } = await load("attraccess/probes.js");
const { inventoryProbe } = await load("attraccess/source.js");
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { TARGET } = await load("attraccess/policy.js");
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const previous = process.argv[2];
if (!previous) throw Error("prior-preparation-required");
const source = JSON.parse(
    readFileSync(join(previous, "source-inventory.json")),
  ),
  recipe = JSON.parse(readFileSync(join(previous, "recipe.json")));
const id =
    "image-verify-" + new Date().toISOString().replace(/[^A-Za-z0-9-]/g, "-"),
  root = join(TARGET.root, id),
  c = new EnvironmentCommands(root, id);
const probes = new OwnedProbes(c);
const outcome = {
  id,
  scope: "preparation-only",
  priorPreparation: previous,
  status: "running",
  startedAt: new Date().toISOString(),
};
c.save("source-inventory", source);
c.save("recipe", recipe);
c.save("attempt", outcome);
try {
  const image = await c.inspectImage(recipe.image),
    mail = await c.inspectImage(TARGET.mailpitImage);
  const probe =
    inventoryProbe("/probe.json") +
    `const n=require(p.join(p.dirname(require.resolve('nx/package.json',{paths:['/app']})),'dist/src/native'));console.log('WorkspaceContext='+typeof n.WorkspaceContext);if(typeof n.WorkspaceContext!=='function')process.exit(3);`;
  writeFileSync(
    join(root, "inventory.json"),
    JSON.stringify(source.inventory),
    { mode: 0o600 },
  );
  writeFileSync(join(root, "probe.cjs"), probe, { mode: 0o600 });
  const receipt = await probes.run(
    image.Id,
    [
      "bash",
      "-c",
      `node --version && pnpm --version && sha256sum /usr/local/bin/node /usr/local/bin/pnpm && find /root/.cache/node/corepack -path '*/bin/pnpm.cjs' -exec sha256sum {} + && git rev-parse HEAD 'HEAD^{tree}' --show-toplevel && git branch --show-current && node /app-probe.cjs`,
    ],
    [
      "--tmpfs",
      "/tmp:rw,size=512m",
      "--env",
      "NX_NATIVE_FILE_CACHE_DIRECTORY=/app/.nx/native",
      "--mount",
      "type=bind,src=" +
        join(root, "inventory.json") +
        ",dst=/probe.json,readonly",
      "--mount",
      "type=bind,src=" +
        join(root, "probe.cjs") +
        ",dst=/app-probe.cjs,readonly",
    ],
    30000,
  );
  Object.assign(outcome, {
    status: "prepared-images",
    finishedAt: new Date().toISOString(),
    devImage: image.Id,
    mailpitImage: mail.Id,
    toolchainAndSource: receipt.stdout,
    sourceInventorySha256: source.inventorySha256,
    recipeSha256: recipe.recipeSha256,
  });
} catch (e) {
  outcome.status = "preparation-failed";
  outcome.error = e.message;
  process.exitCode = 1;
  console.error(JSON.stringify(outcome));
} finally {
  try {
    outcome.cleanup = await probes.close();
  } catch (error) {
    outcome.cleanupError = error.message;
    outcome.status = "preparation-failed";
    process.exitCode = 1;
  } finally {
    c.save("attempt", outcome);
    if (
      outcome.status === "prepared-images" &&
      outcome.cleanup?.status === "complete"
    ) {
      c.save("prepared-images", outcome);
      console.log(JSON.stringify({ root, ...outcome }));
    }
    c.close();
  }
}
