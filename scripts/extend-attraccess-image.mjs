import { load } from "./attraccess-runtime.mjs";
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { TARGET } = await load("attraccess/policy.js");
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { digest } = await load("store/json.js");
const previous = process.argv[2],
  old = JSON.parse(readFileSync(join(previous, "prepared-images.json"))),
  source = JSON.parse(readFileSync(join(previous, "source-inventory.json")));
const id =
    "image-packaging-" +
    new Date().toISOString().replace(/[^A-Za-z0-9-]/g, "-"),
  root = join(TARGET.root, id),
  c = new EnvironmentCommands(root, id),
  image = "rocky-next-env:" + id.toLowerCase();
const recipe = `FROM ${old.devImage}\nRUN apt-get update && apt-get install -y zip && rm -rf /var/lib/apt/lists/*\n`;
writeFileSync(join(root, "Dockerfile"), recipe);
writeFileSync(join(root, ".dockerignore"), "*\n!Dockerfile\n");
c.save("recipe", {
  image,
  recipeSha256: digest(recipe),
  baseRecipeSha256: old.recipeSha256,
  baseImage: old.devImage,
});
c.save("source-inventory", source);
const outcome = {
  id,
  scope: "preparation-only",
  status: "running",
  priorPreparation: previous,
  startedAt: new Date().toISOString(),
};
c.save("attempt", outcome);
try {
  await c.dockerCommand([
    "build",
    "--label",
    "rocky-next.owner=" + id,
    "--tag",
    image,
    root,
  ]);
  const built = await c.inspectImage(image);
  Object.assign(outcome, {
    status: "prepared-images",
    devImage: built.Id,
    mailpitImage: old.mailpitImage,
    sourceInventorySha256: source.inventorySha256,
    recipeSha256: digest(recipe),
    finishedAt: new Date().toISOString(),
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
