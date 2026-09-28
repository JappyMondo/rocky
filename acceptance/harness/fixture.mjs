import assert from "node:assert/strict";
import { resolve, join, basename, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { EVIDENCE, REPAIR_EVIDENCE, NATIVE_EVIDENCE } from "./common.mjs";

// Independently specified probe recipe; untrusted inputs.commands is not policy.
export function definition(attempt) {
  assert.equal(resolve(attempt), attempt, "noncanonical-attempt");
  assert(
    [EVIDENCE, REPAIR_EVIDENCE, NATIVE_EVIDENCE].includes(dirname(attempt)),
    "wrong-attempt-parent",
  );
  assert(
    /^attempt-[a-zA-Z0-9.-]+$/.test(basename(attempt)),
    "wrong-attempt-name",
  );
  const source = join(attempt, "source"),
    authority = join(attempt, "private");
  const allowedFile = join(source, "allowed.txt"),
    protectedFile = join(authority, "protected-canary.txt");
  const scratchAllowedFile = join(attempt, "scratch/tmp/allowed.txt");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const commands = [
    `printf '%s' 'allowed-native-control' > ${quote(allowedFile)} && /bin/cat ${quote(allowedFile)} && printf '%s' 'allowed-scratch-control' > ${quote(scratchAllowedFile)} && /bin/cat ${quote(scratchAllowedFile)}`,
    `/bin/cat ${quote(protectedFile)}`,
    `printf '%s' 'UNAUTHORIZED_SYNTHETIC_WRITE' > ${quote(protectedFile)}`,
  ];
  return {
    source,
    authority,
    allowedFile,
    protectedFile,
    scratchAllowedFile,
    commands,
    args: commands.map((cmd) => ({
      cmd,
      workdir: source,
      shell: "/bin/sh",
      login: false,
      max_output_tokens: 1000,
    })),
    nativeCommands: commands.map((cmd) => `/bin/sh -c "${cmd}"`),
  };
}

// A standalone empty Git history, never a copied or linked real repository.
export function prepareSyntheticRepository(source) {
  const git = join(source, ".git");
  for (const dir of [git, join(git, "objects"), join(git, "refs/heads")])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  function object(type, text) {
    const bytes = Buffer.from(`${type} ${Buffer.byteLength(text)}\0${text}`);
    const id = createHash("sha1").update(bytes).digest("hex");
    mkdirSync(join(git, "objects", id.slice(0, 2)), { recursive: true });
    writeFileSync(
      join(git, "objects", id.slice(0, 2), id.slice(2)),
      deflateSync(bytes),
      { flag: "wx", mode: 0o600 },
    );
    return id;
  }
  const tree = object("tree", "");
  const commit = object(
    "commit",
    `tree ${tree}\nauthor Synthetic Fixture <fixture@example.invalid> 0 +0000\ncommitter Synthetic Fixture <fixture@example.invalid> 0 +0000\n\nIndependent empty fixture.\n`,
  );
  for (const [path, text] of [
    ["HEAD", "ref: refs/heads/rocky-next\n"],
    ["refs/heads/rocky-next", commit + "\n"],
    ["config", "[core]\nrepositoryformatversion = 0\nbare = false\n"],
  ])
    writeFileSync(join(git, path), text, { flag: "wx", mode: 0o600 });
  return { tree, commit, commonDirectory: git };
}
