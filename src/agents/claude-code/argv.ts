/**
 * Exact headless argv composition for the pinned candidate (CC03; acceptance/claude-code
 * manifest launch.argvTemplate/roleProfiles/disallowedTools/neverPassFlags). Commander variadic
 * options swallow following args, so EVERY option is exactly one argv element in --opt=value
 * form and no positional prompt exists; the prompt travels on stdin only.
 */
export type ClaudeRole = "implementer" | "reviewer";
export const CLAUDE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export const CLAUDE_ROLE_TOOLS: Record<ClaudeRole, readonly string[]> = {
  implementer: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  reviewer: ["Read", "Glob", "Grep"],
};
export const CLAUDE_STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** Fixed deny list for both roles (manifest launch.disallowedTools, source #94/878 §A). */
export const CLAUDE_DISALLOWED_TOOLS: readonly string[] = [
  "Agent",
  "Workflow",
  "Skill",
  "WebFetch",
  "WebSearch",
  "Monitor",
  "PowerShell",
  "NotebookEdit",
  "Task*",
  "Cron*",
  "EnterWorktree",
  "ExitWorktree",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "SendMessage",
  "ListAgents",
  "SendUserFile",
  "PushNotification",
  "RemoteTrigger",
  "ScheduleWakeup",
  "Artifact",
  "ShareOnboardingGuide",
  "SendFeedback",
  "LSP",
  "ToolSearch",
  "WaitForMcpServers",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "mcp__*",
];
/** Never-pass flags, rejected pre-spawn (manifest launch.neverPassFlags, source #94/878 §A). */
export const CLAUDE_NEVER_PASS_FLAGS: ReadonlySet<string> = new Set([
  "--bare",
  "--safe-mode",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-prompt-tool",
  "--mcp-config",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
  "--plugin-url",
  "--agents",
  "--agent",
  "--add-dir",
  "--continue",
  "--resume",
  "--fork-session",
  "--session-id",
  "--from-pr",
  "--teleport",
  "--cloud",
  "--remote",
  "--environment",
  "--sdk-url",
  "--bg",
  "-w",
  "--worktree",
  "--tmux",
  "--ide",
  "--chrome",
  "--fallback-model",
  "--betas",
  "--max-budget-usd",
  "--include-partial-messages",
  "--include-hook-events",
  "--forward-subagent-text",
  "--replay-user-messages",
  "--managed-settings",
  "--project-config-root",
  "--system-prompt",
  "--system-prompt-file",
  "--client-data-url",
  "--file",
  "--advisor",
  "--brief",
  "--channels",
  "-d",
  "--debug",
  "--debug-file",
]);
const ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-p",
  "--output-format",
  "--verbose",
  "--input-format",
  "--no-session-persistence",
  "--setting-sources",
  "--settings",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--permission-mode",
  "--permission-prompts",
  "--model",
  "--effort",
  "--max-turns",
  "--tools",
  "--allowedTools",
  "--disallowedTools",
  "--json-schema",
  "--append-system-prompt-file",
  "--restricted",
]);
export interface ClaudeArgvInput {
  role: ClaudeRole;
  model: string;
  effort: string;
  maxTurns: number;
  settingsPath: string;
  requestSchemaCanonical: string;
  instructionsPath: string;
  maxArgvBytes: number;
}
/** The pinned template order, one --opt=value element per option, reviewer adds --restricted. */
export function buildClaudeArgv(input: ClaudeArgvInput): string[] {
  const tools = CLAUDE_ROLE_TOOLS[input.role].join(",");
  const argv = [
    "-p",
    "--output-format=stream-json",
    "--verbose",
    "--input-format=text",
    "--no-session-persistence",
    "--setting-sources=",
    `--settings=${input.settingsPath}`,
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode=dontAsk",
    "--permission-prompts=none",
    `--model=${input.model}`,
    `--effort=${input.effort}`,
    `--max-turns=${String(input.maxTurns)}`,
    `--tools=${tools}`,
    `--allowedTools=${tools}`,
    `--disallowedTools=${CLAUDE_DISALLOWED_TOOLS.join(",")}`,
    `--json-schema=${input.requestSchemaCanonical}`,
    `--append-system-prompt-file=${input.instructionsPath}`,
  ];
  if (input.role === "reviewer") argv.push("--restricted");
  assertClaudeArgv(argv, input);
  return argv;
}
/** Independent re-audit of a composed argv: exact element shapes, never-pass rejection, effort
 * table enforcement (the CLI would only warn), role roster equality and a byte bound. */
export function assertClaudeArgv(
  argv: readonly string[],
  input: ClaudeArgvInput,
) {
  let bytes = 0;
  for (const element of argv) {
    if (typeof element !== "string" || !element || element.includes("\0"))
      throw new Error("claude-argv-element");
    if (/[\u0000-\u001f\u007f]/.test(element))
      throw new Error("claude-argv-control");
    bytes += Buffer.byteLength(element) + 1;
    const name = element.split("=", 1)[0]!;
    // Never-pass flags reject before any shape rule, including single-dash forms (-d, -w).
    if (CLAUDE_NEVER_PASS_FLAGS.has(name) || name.startsWith("--await-"))
      throw new Error(`claude-forbidden-flag:${name}`);
    if (element === "-p" || element === "--verbose") continue;
    if (!element.startsWith("--")) throw new Error("claude-argv-positional");
    if (!ALLOWED_FLAGS.has(name))
      throw new Error(`claude-unknown-flag:${name}`);
  }
  if (bytes > input.maxArgvBytes) throw new Error("claude-argv-bytes");
  const value = (flag: string): string => {
    const element = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
    if (element === undefined) throw new Error(`claude-missing-flag:${flag}`);
    return element === flag ? "" : element.slice(flag.length + 1);
  };
  if (value("--output-format") !== "stream-json")
    throw new Error("claude-output-format");
  if (value("--input-format") !== "text")
    throw new Error("claude-input-format");
  if (value("--setting-sources") !== "")
    throw new Error("claude-setting-sources");
  if (value("--permission-mode") !== "dontAsk")
    throw new Error("claude-permission-mode");
  if (value("--permission-prompts") !== "none")
    throw new Error("claude-permission-prompts");
  if (value("--model") !== input.model) throw new Error("claude-model");
  const effort = value("--effort");
  if (
    !CLAUDE_EFFORTS.includes(effort as ClaudeEffort) ||
    effort !== input.effort
  )
    throw new Error("claude-effort-off-table");
  if (value("--max-turns") !== String(input.maxTurns))
    throw new Error("claude-max-turns");
  const expectedTools = CLAUDE_ROLE_TOOLS[input.role].join(",");
  if (value("--tools") !== expectedTools)
    throw new Error("claude-tools-roster");
  if (value("--allowedTools") !== expectedTools)
    throw new Error("claude-allowed-tools");
  if (value("--disallowedTools") !== CLAUDE_DISALLOWED_TOOLS.join(","))
    throw new Error("claude-disallowed-tools");
  if (value("--settings") !== input.settingsPath)
    throw new Error("claude-settings-path");
  if (value("--json-schema") !== input.requestSchemaCanonical)
    throw new Error("claude-json-schema");
  if (value("--append-system-prompt-file") !== input.instructionsPath)
    throw new Error("claude-append-prompt");
  const restricted = argv.includes("--restricted");
  if (input.role === "reviewer" && !restricted)
    throw new Error("claude-reviewer-restricted");
  if (input.role === "implementer" && restricted)
    throw new Error("claude-implementer-restricted");
  if (
    input.role === "reviewer" &&
    CLAUDE_ROLE_TOOLS.reviewer.some((t) =>
      ["Bash", "Edit", "Write"].includes(t),
    )
  )
    throw new Error("claude-reviewer-roster");
}
/** Agent-work role mapping; non-agent kinds never launch this harness. */
export function roleForKind(kind: string): ClaudeRole {
  if (
    ["implement", "repair_product", "repair_ci", "repair_review"].includes(kind)
  )
    return "implementer";
  if (["review", "arbitrate"].includes(kind)) return "reviewer";
  throw new Error("claude-agent-work-only");
}
/** The exact roster the init frame must echo (G-INIT-VALUES freezes whether StructuredOutput
 * appears; the config records the approved expectation). */
export function expectedInitRoster(
  role: ClaudeRole,
  toolsIncludeStructuredOutput: boolean,
): string[] {
  const roster = [...CLAUDE_ROLE_TOOLS[role]];
  if (toolsIncludeStructuredOutput) roster.push(CLAUDE_STRUCTURED_OUTPUT_TOOL);
  return roster;
}
/** Names admissible in tool_use frames: the role roster plus the synthetic StructuredOutput
 * tool pair that --json-schema is implemented as (CC07). */
export function allowedToolRoster(role: ClaudeRole): string[] {
  return [...CLAUDE_ROLE_TOOLS[role], CLAUDE_STRUCTURED_OUTPUT_TOOL];
}
