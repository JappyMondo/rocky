import { EnvironmentCommands } from "../dist/attraccess/commands.js";
import { TARGET } from "../dist/attraccess/policy.js";
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
  const probe = `const fs=require('fs'),crypto=require('crypto'),p=require('path');const s=JSON.parse(fs.readFileSync('/probe.json'));const changed=Object.entries(s.inventory).filter(([f,e])=>{try{const x=p.join('/app',f);const st=fs.lstatSync(x);return crypto.createHash('sha256').update(st.isSymbolicLink()?Buffer.from(fs.readlinkSync(x)):fs.readFileSync(x)).digest('hex')!==e.sha256}catch{return true}}).map(([f])=>f);console.log(JSON.stringify({files:Object.keys(s.inventory).length,changed}));if(changed.length)process.exit(2);const n=require(p.join(p.dirname(require.resolve('nx/package.json',{paths:['/app']})),'dist/src/native'));console.log('WorkspaceContext='+typeof n.WorkspaceContext);if(typeof n.WorkspaceContext!=='function')process.exit(3);`;
  writeFileSync(join(root, "probe.cjs"), probe, { mode: 0o600 });
  const receipt = await c.dockerCommand(
    [
      "run",
      "--rm",
      "--label",
      "rocky-next.owner=" + id,
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,size=512m",
      "--env",
      "NX_NATIVE_FILE_CACHE_DIRECTORY=/app/.nx/native",
      "--mount",
      "type=bind,src=" +
        join(root, "source-inventory.json") +
        ",dst=/probe.json,readonly",
      "--mount",
      "type=bind,src=" +
        join(root, "probe.cjs") +
        ",dst=/app-probe.cjs,readonly",
      image.Id,
      "bash",
      "-c",
      `node --version && pnpm --version && sha256sum /usr/local/bin/node /usr/local/bin/pnpm && find /root/.cache/node/corepack -path '*/bin/pnpm.cjs' -exec sha256sum {} + && git rev-parse HEAD 'HEAD^{tree}' --show-toplevel && git branch --show-current && node /app-probe.cjs`,
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
  c.save("prepared-images", outcome);
  console.log(JSON.stringify({ root, ...outcome }));
} catch (e) {
  outcome.status = "preparation-failed";
  outcome.error = e.message;
  process.exitCode = 1;
  console.error(JSON.stringify(outcome));
} finally {
  c.save("attempt", outcome);
  c.close();
}
