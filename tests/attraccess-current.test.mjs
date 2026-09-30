import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  discoverCurrent,
  assertATT764Scope,
  stageATT764,
  applyATT764,
  freezeATT764Instructions,
  att764CommitArgs,
  ATT764_TITLE,
} from "../dist/attraccess/current.js";
import { att764OperatorConfig } from "../dist/attraccess/setup.js";
import { validateOperatorConfig } from "../dist/daemon/config.js";

test("ATT-764 commit uses the workspace identity, a verified owned SSH signature and a conventional title", () => {
  const root = mkdtempSync(join(tmpdir(), "att764-signed-")),
    repo = join(root, "repo"),
    key = join(root, "fixture-key");
  mkdirSync(repo);
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "fixture@localhost",
    "-f",
    key,
  ]);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "rocky-next");
  for (const [name, value] of Object.entries({
    "user.name": "Owned Fixture",
    "user.email": "fixture@localhost",
    "gpg.format": "ssh",
    "user.signingkey": key,
    "gpg.ssh.allowedSignersFile": join(root, "allowed-signers"),
  }))
    git("config", name, value);
  writeFileSync(
    join(root, "allowed-signers"),
    "fixture@localhost " + readFileSync(key + ".pub", "utf8"),
  );
  writeFileSync(join(repo, "index.txt"), "owned signing fixture\n");
  git("add", ".");
  git(...att764CommitArgs());
  git("verify-commit", "HEAD");
  assert.equal(
    git("log", "-1", "--format=%an <%ae>"),
    "Owned Fixture <fixture@localhost>",
  );
  assert.equal(git("log", "-1", "--format=%s"), ATT764_TITLE);
  assert.match(ATT764_TITLE, /^fix\(frontend\): .+$/);
  assert.ok(ATT764_TITLE.length <= 120);
});

test("setup's ATT-764 30/120 minute config can be saved with the four MVP action allowances", () => {
  const config = att764OperatorConfig("/owned/target");
  assert.deepEqual(validateOperatorConfig(config), config);
  assert.equal(config.actionMinutes, 30);
  assert.equal(config.totalMinutes, 120);
  assert.throws(
    () => validateOperatorConfig({ ...config, totalMinutes: 119 }),
    /four action allowances/,
  );
});

test("current ATT-764 checks bind clean source, toolchain and narrow non-deleting scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "att764-source-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const put = (path, body) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  };
  git("init", "-b", "rocky-next");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@localhost");
  for (const path of [
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
  ])
    put(path, "fixture\n");
  put(".nvmrc", "24.19.0\n");
  put(
    "package.json",
    JSON.stringify({
      name: "@attraccess/source",
      packageManager: "pnpm@10.34.5",
    }),
  );
  const people = "apps/frontend/src/app/resources/PeopleManagement/index.tsx";
  put(people, "before\n");
  put("AGENTS.md", "frozen instructions\n");
  put("apps/frontend/CONTEXT.md", "frontend instructions\n");
  put(
    "apps/frontend/src/app/resources/PeopleManagement/AGENTS.md",
    "nested instructions\n",
  );
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const staged = mkdtempSync(join(tmpdir(), "att764-stage-"));
  stageATT764(dir, staged);
  assert.equal(existsSync(join(staged, "AGENTS.md")), false);
  assert.equal(existsSync(join(staged, ".git")), false);
  const instructions = freezeATT764Instructions(dir);
  assert.match(instructions, /frontend instructions/);
  assert.match(instructions, /nested instructions/);
  writeFileSync(join(staged, people), "staged change\n");
  writeFileSync(join(staged, "package.json"), "outside change\n");
  assert.throws(() => applyATT764(staged, dir), /scope exceeded/);
  assert.equal(
    readFileSync(join(dir, people), "utf8"),
    "before\n",
    "no partial copying on scope refusal",
  );
  writeFileSync(
    join(staged, "package.json"),
    readFileSync(join(dir, "package.json")),
  );
  applyATT764(staged, dir);
  assert.equal(readFileSync(join(dir, people), "utf8"), "staged change\n");
  assert.equal(
    readFileSync(join(dir, "AGENTS.md"), "utf8"),
    "frozen instructions\n",
  );
  assert.equal(
    readFileSync(
      join(dir, "apps/frontend/src/app/resources/PeopleManagement/AGENTS.md"),
      "utf8",
    ),
    "nested instructions\n",
  );
  unlinkSync(join(staged, people));
  assert.throws(() => applyATT764(staged, dir), /deleting/);
  symlinkSync(join(dir, "package.json"), join(staged, people));
  assert.throws(() => applyATT764(staged, dir), /symlink refused/);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "package.json"))).name,
    "@attraccess/source",
  );
  put(people, "before\n");
  const found = discoverCurrent(dir, join(dir, "owned"));
  assert.equal(found.commit, base);
  assert.equal(found.node, "24.19.0");
  assert.equal(found.pnpm, "10.34.5");
  put(people, "after\n");
  assert.throws(
    () => discoverCurrent(dir, join(dir, "owned")),
    /must be clean/,
  );
  git("add", people);
  git("commit", "-m", "scoped change");
  assert.doesNotThrow(() =>
    assertATT764Scope(dir, base, git("rev-parse", "HEAD")),
  );
  put("outside.txt", "unexpected\n");
  git("add", "outside.txt");
  git("commit", "-m", "outside scope");
  assert.throws(
    () => assertATT764Scope(dir, base, git("rev-parse", "HEAD")),
    /scope exceeded/,
  );
  const beforeDelete = git("rev-parse", "HEAD");
  git("rm", people);
  git("commit", "-m", "delete");
  assert.throws(
    () => assertATT764Scope(dir, beforeDelete, git("rev-parse", "HEAD")),
    /deleting/,
  );
});
