import { EnvironmentCommands } from "../dist/attraccess/commands.js";
import { materialize, verifySnapshot } from "../dist/attraccess/source.js";
import {
  TARGET,
  LIMITS,
  COMMANDS,
  checkPlan,
} from "../dist/attraccess/policy.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { digest } from "../dist/store/json.js";
import { execFileSync } from "node:child_process";
const id = "prepare-" + new Date().toISOString().replaceAll(":", "-");
const root = join(TARGET.root, id);
mkdirSync(root, { recursive: true, mode: 0o700 });
const c = new EnvironmentCommands(root, id);
const outcome = {
  id,
  scope: "preparation-only",
  status: "running",
  startedAt: new Date().toISOString(),
  limits: LIMITS,
};
c.save("attempt", outcome);
try {
  const disk = statfsSync(TARGET.root);
  if (disk.bavail * disk.bsize < LIMITS.diskMinimumBytes)
    throw new Error("insufficient-owned-preparation-disk");
  const context = join(root, "context");
  mkdirSync(context, { mode: 0o700 });
  const copied = materialize(join(context, "source"));
  c.save("source-inventory", copied);
  console.log(
    JSON.stringify({
      stage: "snapshot",
      root,
      files: Object.keys(copied.inventory).length,
    }),
  );
  const recipe = `FROM ${TARGET.nodeImage}\nRUN apt-get update && apt-get install -y python3 python3-venv python3-pip python3-setuptools build-essential libstdc++6 git zip && rm -rf /var/lib/apt/lists/*\nWORKDIR /app\nRUN corepack enable && corepack prepare pnpm@${TARGET.pnpm} --activate\nCOPY source/ .\nRUN pnpm install --frozen-lockfile\nENV NX_DAEMON=false NX_SKIP_NX_CACHE=true CI=true INSTALL_ESP_IDF=false\n`;
  const recipePath = join(context, "Dockerfile.development");
  writeFileSync(recipePath, recipe);
  writeFileSync(
    join(context, ".dockerignore"),
    "source/node_modules\nsource/.nx\nsource/dist\nsource/storage\nsource/.env\n",
  );
  const image = "rocky-next-env:" + id.toLowerCase();
  c.save("recipe", {
    recipeSha256: digest(recipe),
    sourceRecipeSha256: digest(
      readFileSync(join(copied.snapshot, "Dockerfile")),
    ),
    image,
  });
  console.log(JSON.stringify({ stage: "build", image }));
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
  await c.dockerCommand(["pull", TARGET.mailpitImage]);
  const mail = await c.inspectImage(TARGET.mailpitImage);
  const identity = (
    await c.dockerCommand([
      "run",
      "--rm",
      "--network",
      "none",
      image,
      "bash",
      "-c",
      `node --version && pnpm --version && sha256sum /usr/local/bin/node /usr/local/bin/pnpm && git rev-parse HEAD --show-toplevel && node -e 'console.log(typeof require(require("path").join(require("path").dirname(require.resolve("nx/package.json")),"dist/src/native")).WorkspaceContext)'`,
    ])
  ).stdout;
  if (!identity.includes("v" + TARGET.node) || !identity.includes(TARGET.pnpm))
    throw new Error("toolchain-version-mismatch");
  verifySnapshot(copied.snapshot, copied.inventory);
  Object.assign(outcome, {
    status: "prepared-images",
    finishedAt: new Date().toISOString(),
    devImage: built.Id,
    mailpitImage: mail.Id,
    mailpitDigests: mail.RepoDigests,
    toolchain: identity,
    sourceInventorySha256: copied.inventorySha256,
    recipeSha256: digest(recipe),
    commands: COMMANDS,
    checkPlan: checkPlan(TARGET.commit, TARGET.commit),
  });
  c.save("prepared-images", outcome);
  console.log(JSON.stringify(outcome));
} catch (error) {
  Object.assign(outcome, {
    status: "preparation-failed",
    error: error.message,
    finishedAt: new Date().toISOString(),
  });
  c.save("attempt", outcome);
  console.error(JSON.stringify(outcome));
  process.exitCode = 1;
} finally {
  c.save("attempt", outcome);
  c.close();
}
