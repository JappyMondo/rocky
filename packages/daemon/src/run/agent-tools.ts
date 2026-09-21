import { z } from 'zod';
import type { AgentCallOpts } from '@rocky/sdk';

export class AgentBlockedError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'AgentBlockedError';
  }
}
const blocker = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    requiredTool: z.string().trim().min(1).max(500),
    fix: z.string().trim().min(1).max(2000),
  })
  .strict();
export function checkAgentBlocker(text: string): void {
  // Match the final envelope after streamed commentary, never one quoted inside a result.
  const start = text.lastIndexOf('<blocked>');
  const match =
    start < 0
      ? null
      : /^<blocked>([\s\S]*?)<\/blocked>\s*$/.exec(text.slice(start));
  if (!match) return;
  let value;
  try {
    value = blocker.parse(JSON.parse(match[1]));
  } catch {
    throw new AgentBlockedError(
      'Agent reported a tool blocker without valid reason, requiredTool and fix fields. Inspect this Step and correct its tool contract before retrying.',
    );
  }
  throw new AgentBlockedError(
    `${value.reason}\nRequired tool or access: ${value.requiredTool}\nFix: ${value.fix}`,
  );
}
export function agentToolInstructions(
  opts: Pick<AgentCallOpts, 'tools' | 'mcp'>,
): string {
  return [
    `Enabled capabilities: ${opts.tools?.join(', ') || 'none'}.`,
    `Enabled MCP servers: ${opts.mcp?.join(', ') || 'none'}.`,
    'These are the complete grants for this Step. read provides file reading/search; edit provides file changes; bash provides local commands. Do not assume shell, browser, network tools, or external service access from read alone. Tool availability does not override the task restrictions.',
    'Do not inspect .git/HEAD: repository members are Git worktrees and .git may be an indirection file. Read-only content inspection does not require checking Git branches. If modifying files, verify the assigned directory and branch with git before editing; do not follow metadata pointers manually or substitute another checkout.',
    ...(opts.tools?.includes('bash')
      ? [
          'For implementation and repair, prepare the assigned workspace before running checks: use the configured install command or inspect repository setup documentation and lockfiles for the supported dependency install. Missing node_modules or a host service executable alone is not an external blocker. Check available container runtimes for disposable test services, use isolated data and ports, and clean up services you start. Retain actual command results. Required acceptance tests and benchmarks belong to the assigned implementation/repair unless an explicit configured step owns them; do not defer them to an assumed later validation agent. Escalate only after the supported local setup fails or requires unavailable credentials, external infrastructure, or authority.',
          'A bundled Mermaid syntax checker is available: pipe Markdown to "$ROCKY_NODE" "$ROCKY_MERMAID_CHECK" (or add --source for one raw diagram). It reads stdin and emits JSON with a content hash, per-diagram parser results and rendered:false. Exit 0 means valid, 1 means invalid diagrams, 2 means the validator is unavailable. It never renders screenshots or writes repository files. No package installation is needed.',
        ]
      : []),
    ...(opts.tools?.includes('bash')
      ? [
          'For browser automation, first check command -v agent-browser. An installed agent-browser CLI works through bash even without a browser MCP server or workspace Playwright dependency. Read agent-browser skills get core before using it; use --session "$ROCKY_BROWSER_SESSION" for all browser commands, then close that session. Do not infer that browsers are unavailable solely from missing playwright/chromium commands. If neither browser MCP nor this CLI is available for a required capture, return the blocked envelope with that missing dependency.',
        ]
      : []),
    'Only operations assigned to this Step determine whether it is blocked. Do not demand tools or completed effects owned by later or separate Workflow steps. A review of missing/incorrect evidence should return actionable review problems for the responsible Step; it should not attempt to produce that evidence itself.',
    'If a required operation or validation cannot be performed with these tools, stop and return only <blocked>{"reason":"what is blocked","requiredTool":"specific missing capability, command, MCP server or access","fix":"concrete Workflow/configuration change needed"}</blocked>. Do not turn an infrastructure blocker into a content defect, repeat equivalent failed calls, fabricate verification, or attempt to bypass the grants. This alternative envelope replaces the normal result schema.',
  ].join('\n');
}
