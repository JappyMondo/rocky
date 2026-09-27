import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const runtime = process.env.ROCKY_ADAPTER_ROOT
  ? resolve(process.env.ROCKY_ADAPTER_ROOT, "dist")
  : resolve("dist");
const driverPackage = createRequire(
  pathToFileURL(join(runtime, "index.js")),
).resolve("playwright/package.json");
const driverRoot = dirname(driverPackage);
const load = (path) => import(pathToFileURL(join(runtime, path)).href);
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { AttraccessEnvironment } = await load("attraccess/environment.js");
const { TARGET } = await load("attraccess/policy.js");
const { digest, canonical } = await load("store/json.js");
const imagePreparation = process.argv[2];
if (!imagePreparation) throw new Error("image-preparation-directory-required");
const images = JSON.parse(
    readFileSync(join(imagePreparation, "prepared-images.json")),
  ),
  source = JSON.parse(
    readFileSync(join(imagePreparation, "source-inventory.json")),
  );
const id =
  "runtime-prep-" + new Date().toISOString().replace(/[^A-Za-z0-9-]/g, "-");
const root = join(TARGET.root, id);
mkdirSync(root, { recursive: true, mode: 0o700 });
const c = new EnvironmentCommands(root, id);
let environment;
const outcome = {
  id,
  scope: "preparation-only",
  startedAt: new Date().toISOString(),
  status: "running",
};
c.save("attempt", outcome);
try {
  const browserRoot = join(TARGET.root, "browsers-1.60.0");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
  await c.command("/usr/bin/env", [
    "PLAYWRIGHT_BROWSERS_PATH=" + browserRoot,
    process.execPath,
    join(driverRoot, "cli.js"),
    "install",
    "chromium",
  ]);
  // executablePath resolves the private browser registry when imported after setting its environment.
  const executable = (
    await c.command("/usr/bin/env", [
      "PLAYWRIGHT_BROWSERS_PATH=" + browserRoot,
      process.execPath,
      "--input-type=module",
      "-e",
      `import {chromium} from ${JSON.stringify(pathToFileURL(join(driverRoot, "index.mjs")).href)};console.log(chromium.executablePath())`,
    ])
  ).stdout.trim();
  const browserVersion = (
    await c.command(executable, ["--version"])
  ).stdout.trim();
  c.save("browser-prepared", {
    driver: "playwright@1.60.0",
    driverPackageSha256: digest(readFileSync(driverPackage)),
    version: browserVersion,
    executable,
    sha256: digest(readFileSync(executable)),
  });
  const prepared = {
    devImage: images.devImage,
    mailpitImage: images.mailpitImage,
    sourceInventory: source.inventory,
    browserExecutable: executable,
    shellyZip: join(root, "plugin-shelly.zip"),
  };
  environment = new AttraccessEnvironment(prepared, id + "-environment");
  const session = await environment.provision("member");
  await environment.exec(session, ["pnpm", "nx", "run", "plugin-shelly:zip"]);
  await c.dockerCommand([
    "cp",
    session.container + ":/app/apps/plugins/shelly/dist/plugin-shelly.zip",
    prepared.shellyZip,
  ]);
  const zipInventory = JSON.parse(
    (
      await c.command("/usr/bin/python3", [
        "-B",
        "-c",
        "import zipfile,hashlib,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in sorted(z.namelist()) if not n.endswith('/') }))",
        prepared.shellyZip,
      ])
    ).stdout,
  );
  c.save("plugin-prepared", {
    sha256: digest(readFileSync(prepared.shellyZip)),
    members: zipInventory,
  });
  const readiness = await environment.start(session);
  const isolation = await environment.isolationProbe(session);
  const fixtures = await environment.provisionAccounts(session);
  const sourceAfter = await environment.verifySource(session);
  const stopped = await environment.stop();
  environment = undefined;
  Object.assign(outcome, {
    status: "prepared-runtime",
    finishedAt: new Date().toISOString(),
    prepared,
    browser: {
      driver: "playwright@1.60.0",
      driverPackageSha256: digest(readFileSync(driverPackage)),
      version: browserVersion,
      executable,
      sha256: digest(readFileSync(executable)),
    },
    shelly: {
      sha256: digest(readFileSync(prepared.shellyZip)),
      members: zipInventory,
    },
    sourceAfter,
    readiness,
    isolation,
    fixtures,
    runtime,
    cleanup: stopped,
  });
  c.save("prepared-runtime", outcome);
  console.log(
    JSON.stringify({
      root,
      status: outcome.status,
      browser: outcome.browser,
      shelly: outcome.shelly,
    }),
  );
} catch (error) {
  Object.assign(outcome, {
    status: "preparation-failed",
    error: error.message,
    finishedAt: new Date().toISOString(),
  });
  console.error(JSON.stringify(outcome));
  process.exitCode = 1;
} finally {
  if (environment)
    try {
      outcome.cleanup = await environment.stop();
    } catch (error) {
      outcome.cleanupError = error.message;
    }
  c.save("attempt", outcome);
  c.close();
}
