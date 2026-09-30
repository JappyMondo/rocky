/** One current-head ATT-764 recipe. Historical qualification defaults are unchanged. */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statfsSync,
  realpathSync,
  cpSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { join, resolve, basename, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { EnvironmentCommands } from "./commands.js";
import {
  AttraccessEnvironment,
  type PreparedEnvironment,
} from "./environment.js";
import { LIMITS, TARGET } from "./policy.js";
import {
  trackedSourceInventory,
  verifySnapshot,
  type CurrentSource,
} from "./source.js";
import { digest, canonical } from "../store/json.js";
import { att764Acceptance } from "./current-acceptance.js";

export const ATT764_TASK =
  "ATT-764: Use resource-group wording in the People & Permissions subtitle for groups in English and German. Preserve resource wording, both management-action branches, and hidden headers. Add focused regression tests.";
export const ATT764_RECIPE = "attraccess-att764-v1";
const people = "apps/frontend/src/app/resources/PeopleManagement/";
const excluded =
  /^(AGENTS\.md|CLAUDE\.md|CONTEXT\.md|opencode\.jsonc?|\.opencode|\.git|node_modules)$/;
/** Instructions are frozen as prompt data; native discovery stays disabled. */
export function freezeATT764Instructions(source: string) {
  const files = git(source, "ls-files", "-z").split("\0").filter(Boolean);
  return files
    .filter((path) => {
      if (!/^(AGENTS\.md|CLAUDE\.md|CONTEXT\.md)$/.test(basename(path)))
        return false;
      const parent = dirname(path);
      return (
        parent === "." ||
        people.startsWith(parent + "/") ||
        path.startsWith(people)
      );
    })
    .sort()
    .map((path) => {
      if (!lstatSync(join(source, path)).isFile())
        throw new Error("Instruction must be a regular file: " + path);
      return path + ":\n" + readFileSync(join(source, path), "utf8");
    })
    .join("\n\n");
}
export function stageATT764(source: string, destination: string) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => !excluded.test(basename(path)),
  });
}
export function applyATT764(staged: string, workspace: string) {
  const inventory = (root: string) => {
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (excluded.test(name)) continue;
        const path = join(dir, name),
          key = relative(root, path),
          stat = lstatSync(path);
        if (stat.isDirectory()) walk(path);
        else if (stat.isSymbolicLink())
          files[key] = "link:" + readlinkSync(path);
        else if (stat.isFile())
          files[key] =
            (stat.mode & 0o111 ? "755:" : "644:") + digest(readFileSync(path));
        else throw new Error("Unsupported scoped source entry: " + key);
      }
    };
    walk(root);
    return files;
  };
  const before = inventory(workspace),
    after = inventory(staged);
  const changed = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter((path) => before[path] !== after[path]);
  // Validate every change before copying any bytes back. Existing instructions remain in place.
  for (const path of changed) {
    if (
      !path.startsWith(people) ||
      path === people + "rocky-host-acceptance.test.tsx"
    )
      throw new Error("ATT-764 scope exceeded: " + path);
    if (!after[path])
      throw new Error("ATT-764 does not permit deleting existing source/tests");
    if (after[path]!.startsWith("link:"))
      throw new Error("ATT-764 changed symlink refused: " + path);
    let parent = dirname(join(workspace, path));
    while (parent !== workspace) {
      if (existsSync(parent) && !lstatSync(parent).isDirectory())
        throw new Error("ATT-764 copy parent is not a directory");
      parent = dirname(parent);
    }
  }
  for (const path of changed) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    cpSync(join(staged, path), join(workspace, path), { dereference: false });
  }
}
const recipePaths = [
  ".nvmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "Dockerfile",
  "scripts/setup-dev-dependencies.sh",
  "scripts/dev-serve.mts",
  "scripts/seed-dev-user.mjs",
  "apps/frontend/project.json",
  "apps/frontend/vitest.config.ts",
  "libs/react-query-client/project.json",
];
export function git(source: string, ...args: string[]) {
  return execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  }).trim();
}
export function discoverCurrent(source: string, root: string): CurrentSource {
  source = realpathSync(source);
  root = resolve(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const commit = git(source, "rev-parse", "HEAD"),
    tree = git(source, "rev-parse", "HEAD^{tree}");
  if (git(source, "status", "--porcelain", "--untracked-files=no"))
    throw new Error("Target source must be clean");
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (pkg.name !== "@attraccess/source")
    throw new Error("Only Attraccess is supported by this recipe");
  const node = readFileSync(join(source, ".nvmrc"), "utf8")
    .trim()
    .replace(/^v/, "");
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha512\.[a-f0-9]+)?$/.exec(
    pkg.packageManager,
  )?.[1];
  if (!/^24\.\d+\.\d+$/.test(node) || !pnpm)
    throw new Error("Unsupported target toolchain declaration");
  const recipeFiles = Object.fromEntries(
    recipePaths.map((path) => [path, digest(readFileSync(join(source, path)))]),
  );
  return {
    source,
    root,
    commit,
    tree,
    node,
    pnpm,
    packageManager: pkg.packageManager,
    recipeFiles,
  };
}
export function assertATT764Scope(source: string, base: string, head: string) {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head))
    throw new Error("Frozen base/head required");
  for (const path of git(source, "diff", "--name-only", base, head, "--")
    .split("\n")
    .filter(Boolean))
    if (
      !path.startsWith(people) ||
      path === people + "rocky-host-acceptance.test.tsx"
    )
      throw new Error("ATT-764 scope exceeded: " + path);
  if (git(source, "diff", "--diff-filter=D", "--name-only", base, head, "--"))
    throw new Error("ATT-764 does not permit deleting existing source/tests");
}
export function currentCheckRecipe() {
  return {
    name: "ATT-764 component checks and group-page smoke (EN/DE)",
    file: process.execPath,
    args: [fileURLToPath(new URL("./current-cli.js", import.meta.url))],
  };
}
export interface CurrentPrepared extends PreparedEnvironment {
  target: CurrentSource;
  recipe: string;
  recipeSha256: string;
}
/** Resolve image/toolchain identities, then build only owned images with copied source/tests. */
export async function prepareCurrent(
  source: string,
  root: string,
): Promise<CurrentPrepared> {
  const target = discoverCurrent(source, root),
    id = "prepare-" + randomUUID(),
    dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c = new EnvironmentCommands(dir, id, undefined, "scoped-att764-setup", {
    head: target.commit,
    base: target.commit,
  });
  try {
    const disk = statfsSync(root);
    if (disk.bavail * disk.bsize < LIMITS.diskMinimumBytes)
      throw new Error("Insufficient disk for isolated Attraccess setup");
    await c.dockerCommand(["info", "--format", "{{.ServerVersion}}"], 10000);
    const nodeTag = `node:${target.node}-trixie`;
    await c.dockerCommand(["pull", nodeTag]);
    const node = await c.inspectImage(nodeTag);
    await c.dockerCommand(["pull", TARGET.mailpitImage]);
    const mail = await c.inspectImage(TARGET.mailpitImage);
    const context = join(dir, "context"),
      snapshot = join(context, "source");
    mkdirSync(context);
    await c.command(
      "/usr/bin/git",
      ["clone", "--no-hardlinks", "--no-checkout", "--", source, snapshot],
      60000,
    );
    await c.command(
      "/usr/bin/git",
      ["-C", snapshot, "checkout", "--detach", target.commit],
      30000,
    );
    await c.command(
      "/usr/bin/git",
      ["-C", snapshot, "remote", "remove", "origin"],
      30000,
    );
    const inventory = trackedSourceInventory(source, target.commit);
    verifySnapshot(snapshot, inventory);
    // Original .dockerignore excludes tests and .git; the owned context deliberately retains both.
    writeFileSync(
      join(context, ".dockerignore"),
      "source/node_modules\nsource/.nx\nsource/dist\nsource/storage\nsource/.env\n",
    );
    const recipe = `FROM ${node.Id}\nRUN apt-get update && apt-get install -y python3 python3-venv python3-pip python3-setuptools build-essential libstdc++6 git zip && rm -rf /var/lib/apt/lists/*\nWORKDIR /app\nCOPY source/ ./\nENV NX_DAEMON=false NX_SKIP_NX_CACHE=true CI=true INSTALL_ESP_IDF=false HUSKY=0\nRUN corepack enable && corepack prepare pnpm@${target.pnpm} --activate && pnpm install --frozen-lockfile\n`;
    writeFileSync(join(context, "Dockerfile"), recipe);
    const tag = "rocky-next-att764:" + target.tree.slice(0, 16);
    c.save("recipe", {
      target,
      nodeImage: node.Id,
      mailpitImage: mail.Id,
      recipeSha256: digest(recipe),
    });
    await c.dockerCommand([
      "build",
      "--label",
      "rocky-next.owner=" + id,
      "--tag",
      tag,
      context,
    ]);
    const image = await c.inspectImage(tag);
    const browserExecutable = chromium.executablePath();
    if (!existsSync(browserExecutable))
      throw new Error(
        "Install the pinned browser: npx playwright install chromium",
      );
    const prepared: CurrentPrepared = {
      target,
      recipe: ATT764_RECIPE,
      recipeSha256: digest(recipe),
      devImage: image.Id,
      mailpitImage: mail.Id,
      sourceInventory: inventory,
      browserExecutable,
      shellyZip: "",
    };
    c.save("prepared", prepared);
    writeFileSync(
      join(root, "prepared-" + target.tree + ".json"),
      JSON.stringify(prepared, null, 2) + "\n",
      { mode: 0o600 },
    );
    return prepared;
  } finally {
    c.close();
  }
}
export async function loadOrPrepare(source: string, root: string) {
  const target = discoverCurrent(source, root),
    path = join(root, "prepared-" + target.tree + ".json");
  if (existsSync(path)) {
    const p = JSON.parse(readFileSync(path, "utf8")) as CurrentPrepared;
    if (
      p.recipe === ATT764_RECIPE &&
      canonical(p.target.recipeFiles) === canonical(target.recipeFiles)
    ) {
      p.target = target;
      p.sourceInventory = trackedSourceInventory(source, target.commit);
      return p;
    }
  }
  return prepareCurrent(source, root);
}
export async function runCurrentChecks(
  source: string,
  root: string,
  phase: "baseline" | "product",
  base: string,
) {
  const target = discoverCurrent(source, root);
  assertATT764Scope(source, base, target.commit);
  const prepared = await loadOrPrepare(source, root);
  const env = new AttraccessEnvironment(prepared, "att764-" + randomUUID(), {
    purpose: "scoped-att764",
    target,
  });
  const stop = () => {
    void env.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let outcome: unknown;
  try {
    const session = await env.provision("admin_resources");
    const toolchain = await env.exec(session, [
      "bash",
      "-c",
      "node --version && pnpm --version",
    ]);
    if (toolchain.stdout.trim() !== `v${target.node}\n${target.pnpm}`)
      throw new Error("Container toolchain drift");
    await env.exec(session, [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "apps/frontend/vitest.config.ts",
      "apps/frontend/src/app/resources/PeopleManagement",
      "--retry",
      "0",
    ]);
    const acceptance = att764Acceptance(phase === "product");
    env.commands.save("host-acceptance", { sha256: digest(acceptance), phase });
    const acceptancePath = people + "rocky-host-acceptance.test.tsx";
    writeFileSync(
      join(session.root, "private", "host-acceptance.tsx"),
      acceptance,
    );
    await env.exec(session, [
      "cp",
      "/owned/private/host-acceptance.tsx",
      acceptancePath,
    ]);
    try {
      await env.exec(session, [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--config",
        "apps/frontend/vitest.config.ts",
        acceptancePath,
        "--retry",
        "0",
      ]);
    } finally {
      await env.exec(session, ["rm", "--", acceptancePath]);
    }
    await env.exec(session, ["pnpm", "nx", "run", "frontend:typecheck"]);
    await env.start(session);
    await env.provisionAccounts(session);
    const api = env.api(session);
    await api.login(session.admin);
    const groups = await api.request("/api/resource-groups");
    const body = groups.body as { id: number; name: string }[];
    if (groups.status !== 200 || !Array.isArray(body))
      throw new Error("Resource-group fixture readback failed");
    const group = body.find((g) => g.name === "group-" + session.id);
    if (!group) throw new Error("Owned resource group is missing");
    const observations = [];
    for (const locale of ["en", "de"] as const)
      observations.push(
        await env.runScopedScenario(session, locale, async (browser, s) => {
          const login = await browser.context.request.post(
            s.apiUrl + "/api/auth/session/local",
            {
              data: {
                username: s.admin.username,
                password: s.admin.password,
                tokenLocation: "cookie",
              },
            },
          );
          if (!login.ok()) throw new Error("Browser session login failed");
          await browser.page.goto(
            s.frontendUrl + "/resource-groups/" + group.id,
            { waitUntil: "domcontentloaded" },
          );
          const people = browser.page.locator(
            '[data-cy="manage-resource-group-people"]',
          );
          await people.waitFor({ state: "visible" });
          const text = await people
            .locator("p.mt-1.text-sm.text-muted")
            .innerText();
          const heading = await people
            .getByRole("heading", { level: 1 })
            .innerText();
          const groupWording =
            locale === "en"
              ? /\bgroup\b/i.test(text)
              : /\bGruppe\b/i.test(text);
          if (
            heading !==
            (locale === "en"
              ? "People & Permissions"
              : "Personen & Berechtigungen")
          )
            throw new Error("People panel did not render in requested locale");
          if (phase === "product" && !groupWording)
            throw new Error(
              "ATT-764: group subtitle still uses resource wording (" +
                locale +
                ")",
            );
          return {
            locale,
            groupWording,
            desiredBehavior: groupWording ? "pass" : "existing-product-defect",
            screenshot: await browser.screenshot("group-" + locale),
          };
        }),
      );
    await env.verifySource(session);
    outcome = {
      phase,
      head: target.commit,
      tree: target.tree,
      checks: "component tests and frontend typecheck passed",
      browser: observations,
      environmentEvidence: env.commands.root,
    };
    env.commands.save("att764-result", outcome);
    return outcome;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await env.stop();
  }
}
