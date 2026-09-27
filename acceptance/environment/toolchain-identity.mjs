// These are the two actual pinned producer commands, not permissive log matching.
const paths = [
  "/usr/local/bin/node",
  "/usr/local/bin/pnpm",
  "/usr/bin/bash",
  "/usr/bin/sed",
  "/usr/bin/rm",
  "/usr/bin/git",
  "/usr/bin/zip",
];
const executables = [paths[0], paths[1], paths[6]];
export function toolchainIdentity(stdout, source) {
  if (typeof stdout !== "string" || !stdout.endsWith("\n"))
    throw Error("toolchain-format");
  const lines = stdout.slice(0, -1).split("\n");
  let body;
  if (lines.length === 12) {
    if (JSON.stringify(lines.slice(0, 7)) !== JSON.stringify(paths))
      throw Error("toolchain-path-drift");
    body = lines.slice(7);
  } else if (lines.length === 9 && source) {
    const inventory = JSON.parse(lines[5]);
    if (
      JSON.stringify(inventory) !==
        JSON.stringify({ files: source.files, changed: [] }) ||
      lines[6] !== source.commit ||
      lines[7] !== source.tree ||
      lines[8] !== "/app"
    )
      throw Error("toolchain-source-receipt-drift");
    body = lines.slice(0, 5);
  } else throw Error("toolchain-format");
  if (!/^v\d+\.\d+\.\d+$/.test(body[0]) || !/^\d+\.\d+\.\d+$/.test(body[1]))
    throw Error("toolchain-version-format");
  const hashes = Object.fromEntries(
    executables.map((path, i) => {
      const m = /^([a-f0-9]{64})  (\/[^ ]+)$/.exec(body[i + 2]);
      if (!m || m[2] !== path) throw Error("toolchain-executable-identity");
      return [path, m[1]];
    }),
  );
  return { node: body[0], pnpm: body[1], executables: hashes };
}
export function verifyToolchain(observed, inputs) {
  const expected = toolchainIdentity(inputs.toolchain.stdout, {
    files: Object.keys(inputs.prepared.sourceInventory).length,
    commit: inputs.targetCommit,
    tree: inputs.targetTree,
  });
  const actual = toolchainIdentity(observed);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error("toolchain-executable-drift");
  return actual;
}
