/**
 * Exact `codex exec --json` argv composition and independent re-audit for the pinned candidate
 * (S01/S04; acceptance/subscription manifest launch.argvTemplate + launch.forbiddenLaunchInputs,
 * source #92/858 §A). The frozen template order is authoritative:
 *   exec --json --color never --skip-git-repo-check --ignore-user-config --ignore-rules
 *       --strict-config --output-schema <schema> --model <model> --ephemeral <-c pairs> -- -
 * Reviewer-only `--image=<path>` flags (visual route, source #92/858 §A [S input route]; native
 * transform gated N08) are inserted immediately after the `--model <model>` pair. The prompt is
 * NEVER a positional argv element: the single trailing positional is "-" (forced stdin, F9).
 */
export type CodexRole = "implementer" | "reviewer";
/** On-table model/effort assignments (manifest launch.models). Unknown or off-table
 * model/effort fails closed and is never defaulted (ticket #81; no fallback/reroute). */
export const CODEX_MODEL_EFFORT_PAIRS: ReadonlySet<string> = new Set([
  "gpt-6-sol\u0000medium",
  "gpt-6-astra\u0000high",
]);
export const CODEX_MODELS: readonly string[] = ["gpt-6-sol", "gpt-6-astra"];
export const CODEX_EFFORTS: readonly string[] = ["medium", "high"];
export function isOnTableModelEffort(model: string, effort: string): boolean {
  return CODEX_MODEL_EFFORT_PAIRS.has(`${model}\u0000${effort}`);
}
/** Never-pass flags and subcommands, rejected pre-spawn (source #92/858 §A "Never pass"). */
export const CODEX_NEVER_PASS: ReadonlySet<string> = new Set([
  "--sandbox",
  "-s",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--approve-for-me",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--cd",
  "-C",
  "--worktree",
  "--profile",
  "-p",
  "--oss",
  "--local-provider",
  "-o",
  "--output-last-message",
  "--thread-source",
  "resume",
  "fork",
  "review",
]);
/** Fixed template prefix that must appear verbatim and in order (manifest launch.argvTemplate). */
const FIXED_PREFIX: readonly string[] = [
  "exec",
  "--json",
  "--color",
  "never",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
];
export interface CodexArgvInput {
  model: string;
  effort: string;
  schemaPath: string;
  /** Rendered `-c` assignment strings ("key=value"), already TOML round-trip validated. */
  overrideAssignments: readonly string[];
  /** Reviewer-only approved image paths (visual route); empty for implementer. */
  images?: readonly string[];
  maxArgvBytes: number;
}
/** Compose the exact argv: fixed prefix, --output-schema, --model, [images], --ephemeral,
 * -c pairs, then `-- -`. Effort travels as a `model_reasoning_effort` override, never a flag. */
export function buildCodexArgv(input: CodexArgvInput): string[] {
  const argv: string[] = [
    ...FIXED_PREFIX,
    "--output-schema",
    input.schemaPath,
    "--model",
    input.model,
  ];
  for (const image of input.images ?? []) argv.push(`--image=${image}`);
  argv.push("--ephemeral");
  for (const assignment of input.overrideAssignments)
    argv.push("-c", assignment);
  argv.push("--", "-");
  assertCodexArgv(argv, input);
  return argv;
}
/** Independent re-audit of a composed argv: exact fixed prefix and terminator, on-table
 * model/effort, never-pass rejection, `-c` pairing, the sandbox+named-permissions combination ban
 * (F7), reviewer image form and a byte bound. This runs on the composed argv AND is re-run by the
 * producer so a hand-tampered argv cannot be admitted. */
export function assertCodexArgv(
  argv: readonly string[],
  input: CodexArgvInput,
) {
  if (!Array.isArray(argv) || argv.length < FIXED_PREFIX.length + 6)
    throw new Error("codex-argv-shape");
  let bytes = 0;
  for (const element of argv) {
    if (typeof element !== "string" || !element || element.includes("\0"))
      throw new Error("codex-argv-element");
    if (/[\u0000-\u001f\u007f]/.test(element))
      throw new Error("codex-argv-control");
    bytes += Buffer.byteLength(element) + 1;
  }
  if (bytes > input.maxArgvBytes) throw new Error("codex-argv-bytes");
  // Never-pass flags/subcommands reject FIRST, regardless of position, before any shape rule
  // (single- and double-dash forms and bare subcommands). A sandbox flag is recorded for the F7
  // combination ban below.
  let sawSandboxFlag = false;
  for (const element of argv) {
    const name = element.split("=", 1)[0]!;
    if (CODEX_NEVER_PASS.has(name) || CODEX_NEVER_PASS.has(element))
      throw new Error(`codex-forbidden-flag:${name}`);
    if (name === "--sandbox" || name === "-s") sawSandboxFlag = true;
  }
  // Exact fixed prefix in order.
  for (let i = 0; i < FIXED_PREFIX.length; i++)
    if (argv[i] !== FIXED_PREFIX[i])
      throw new Error(`codex-argv-prefix:${FIXED_PREFIX[i]}`);
  let sawNamedPermissions = false;
  let at = FIXED_PREFIX.length;
  const expect = (value: string, label: string) => {
    if (argv[at] !== value) throw new Error(`codex-argv-${label}`);
    at++;
  };
  expect("--output-schema", "output-schema-flag");
  const schemaPath = argv[at];
  if (schemaPath !== input.schemaPath)
    throw new Error("codex-argv-schema-path");
  at++;
  expect("--model", "model-flag");
  const model = argv[at];
  if (model !== input.model) throw new Error("codex-argv-model");
  at++;
  // Optional reviewer images immediately after --model, each one --image=<path> element.
  const images: string[] = [];
  while (argv[at] !== undefined && String(argv[at]).startsWith("--image=")) {
    images.push(String(argv[at]).slice("--image=".length));
    at++;
  }
  const expectedImages = [...(input.images ?? [])];
  if (images.length !== expectedImages.length)
    throw new Error("codex-argv-image-count");
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (image === undefined || image !== expectedImages[i])
      throw new Error("codex-argv-image-path");
    if (!image || image.includes(",")) throw new Error("codex-argv-image-path");
  }
  expect("--ephemeral", "ephemeral");
  // -c pairs until the `--` terminator.
  const assignments: string[] = [];
  while (argv[at] === "-c") {
    at++;
    const assignment = argv[at];
    if (typeof assignment !== "string" || !assignment.includes("="))
      throw new Error("codex-argv-override-pair");
    assignments.push(assignment);
    at++;
    if (assignment.startsWith("default_permissions="))
      sawNamedPermissions = true;
  }
  if (argv[at] !== "--" || argv[at + 1] !== "-" || at + 2 !== argv.length)
    throw new Error("codex-argv-terminator");
  // F7: a CLI sandbox override forces legacy syntax and silently drops the named-permission
  // profile; the combination is rejected by source and must never be admitted. (--sandbox/-s are
  // already never-pass, so this is a redundant defense kept explicit for the combination rule.)
  if (sawSandboxFlag && sawNamedPermissions)
    throw new Error("codex-forbidden-sandbox-named-permissions");
  // On-table model/effort only; effort is carried as an override, never a flag.
  if (!CODEX_MODELS.includes(model)) throw new Error("codex-model-off-table");
  const effortAssignment = assignments.find((a) =>
    a.startsWith("model_reasoning_effort="),
  );
  if (effortAssignment === undefined)
    throw new Error("codex-argv-effort-missing");
  const effort = parseEffortAssignment(effortAssignment);
  if (!CODEX_EFFORTS.includes(effort) || effort !== input.effort)
    throw new Error("codex-effort-off-table");
  if (!isOnTableModelEffort(model, effort))
    throw new Error("codex-model-effort-off-table");
  // The composed override set must equal the audited assignments exactly (order included).
  if (
    assignments.length !== input.overrideAssignments.length ||
    assignments.some((a, i) => a !== input.overrideAssignments[i])
  )
    throw new Error("codex-argv-override-drift");
  return argv;
}
function parseEffortAssignment(assignment: string): string {
  const raw = assignment.slice("model_reasoning_effort=".length);
  // The renderer always emits a TOML basic string; strip exactly one pair of quotes.
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}
/** Agent-work role mapping; non-agent kinds never launch this harness. Codex-prefixed to avoid a
 * top-level export collision with the Claude Code adapter's harness-neutral `roleForKind`. */
export function codexRoleForKind(kind: string): CodexRole {
  if (
    ["implement", "repair_product", "repair_ci", "repair_review"].includes(kind)
  )
    return "implementer";
  if (["review", "arbitrate"].includes(kind)) return "reviewer";
  throw new Error("codex-agent-work-only");
}
