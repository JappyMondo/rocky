import type {
  AgentCallOpts,
  WorkflowContext,
  ConfiguredAgent,
  RecapAgentRole,
} from '@rocky/sdk';
import { z } from 'zod';
import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { BootContext } from '../run/replay.js';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseUnifiedDiff } from '../local-api/artifacts.js';
import { KeyChange, ReportContent, ReviewFocus } from './schema.js';

const text = z.string().trim().min(1).max(16000);
export const RecapInventory = z.object({
  variants: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        group: text,
        variant: text,
        description: text,
        instructions: text,
      }),
    )
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      'Variant IDs must be unique',
    ),
  exclusions: z.array(text).max(100),
});
export const RecapNarrative = z.object({
  title: text,
  summary: text,
  problems: ReportContent.shape.problems,
  diagrams: ReportContent.shape.diagrams,
  verification: ReportContent.shape.verification,
  limitations: z.array(text).max(50),
  keyChanges: z.array(KeyChange.omit({ diff: true })).max(30),
  reviewFocus: z
    .array(ReviewFocus)
    .length(8)
    .refine(
      (items) => new Set(items.map((item) => item.category)).size === 8,
      'Assess every review category once, with evidence or an explicit not-applicable reason',
    ),
});
export function CaptureFor(directory: string) {
  return ReportContent.shape.visuals.element.safeExtend({
    screenshots: z
      .array(
        z.object({
          caption: text,
          path: text.refine((path) => {
            try {
              const root = realpathSync(directory);
              const file = realpathSync(resolve(root, path));
              const inside = relative(root, file);
              return (
                inside !== '' &&
                !inside.startsWith('..') &&
                !isAbsolute(inside) &&
                statSync(file).isFile()
              );
            } catch {
              return false;
            }
          }, 'Capture must exist inside screenshotDir'),
        }),
      )
      .max(30),
  });
}

export const RecapAudit = z.object({ problems: z.array(text).max(50) });

export const inventoryPrompt = `Inventory the visual evidence needed for a finished-work recap. Inspect the supplied immutable diff or deliverable and repository context. Identify every meaningful changed screen, route, dialog, role/access state, loading/empty/error/success state, supported theme, breakpoint, locale and feature variant available for the affected surfaces. Include rendered documents and diagrams if the deliverable contains them. Each variant needs a stable ID, group, clear label, description and actionable capture instructions. Inventory only supported combinations, not hypothetical products. List exclusions with specific evidence: unchanged, redundant, not visual, or unsupported. Missing access is not an exclusion: inventory that variant so capture reports the limitation. Work read-only. Review previous audit problems when provided.`;

export const narrativePrompt = `Explain the finished work for a human reviewer. Ground each statement in the supplied diff, deliverable and actual repository context; prior agent summaries are not verification evidence. Select the load-bearing key changes, each with a short plain-language summary followed by the exact paths from changedFiles. Code excerpts are attached by Rocky from the real diff; never generate or rewrite code diffs. Add concise annotations anchored to selected files and actual diff lines when useful. Include a problem/solution overview and diagrams only when they clarify real relationships.
Assess all eight categories exactly once: security (trust boundaries, injection, secrets, dependencies), permissions (roles, grants, authorization checks), routes (new/changed endpoints and access), data (schema/migrations/retention), compatibility (callers/contracts/backwards compatibility), operations (configuration/deployment/rollback), testing (executed checks and gaps), other (remaining important review decisions). Name concrete endpoints and before/after permission changes. Use attention for risks, verified only with evidence, and not-applicable with a reason. Never imply exhaustive security certification. Distinguish tests actually run from recommendations. Explain what the human should inspect first. For a non-code deliverable, return no key changes and review its accuracy/completeness/limitations instead. Work read-only. Resolve previous audit problems if supplied.`;

export const capturePrompt = `Capture the requested visual variant for this exact revision. Use available browser tools or local rendering commands. First check agent-browser via bash and read agent-browser skills get core; a browser MCP server and workspace Playwright installation are not required when this CLI is available. Use the dedicated ROCKY_BROWSER_SESSION and close it after capture. When previewUrl is supplied, it points to the exact deliverable already displayed in Rocky: open it, locate the candidate body, activate its Render diagram controls, wait for the diagrams and inspect the rendered output before capturing the requested section. This is a local preview, not proof of publication in Linear. Do not capture duplicate transcript copies or raw diagram source as rendered evidence. If previewUrl is absent, inspect configuration and start a local preview on the reserved port if needed. Reuse an already-running matching preview when possible. Capture actual screenshots of the requested states; include before/after views when the baseline can be shown reliably. Save new images under screenshotDir using reportId, revision and variant ID in the filename. Never reuse an old-head screenshot. Keep repository files, git and external services unchanged; use temporary files for preview/render inputs, and clean up a server you start before finishing. Return every screenshot with an informative caption. If required capture cannot be performed because no browser or renderer is available, stop using the runner's <blocked> envelope so configuration can be fixed before any more capture Steps run. For a variant-specific limitation despite functioning tools (for example an inaccessible role or unsupported state), return status unavailable, no screenshots, and its concrete reason. Never fabricate evidence, substitute a mockup, or claim an unperformed render passed. Rocky hosts these screenshots itself.`;

/** Multi-agent authoring with explicit coverage and an independent final audit. */
export async function generateRecapContent(input: {
  steps: BootContext;
  agent: WorkflowContext['agent'];
  agentOptions: AgentCallOpts;
  agents?: Record<RecapAgentRole, (input: unknown) => ConfiguredAgent>;
  context: Record<string, unknown>;
  diff: string;
  deliverable?: string;
}) {
  // Defaults keep legacy SDK workflows replayable; flow coordinators supply all four agents.
  const call = <S extends z.ZodType>(
    role: RecapAgentRole,
    prompt: string,
    options: AgentCallOpts<S> & { schema: S; label: string },
  ) => {
    const configured = input.agents?.[role](options.input);
    if (!configured)
      return input.agent({ prompt }, { ...input.agentOptions, ...options });
    const opts = {
      ...configured.options,
      ...options,
      input: configured.options.input,
      tools: configured.options.tools,
      mcp: configured.options.mcp,
    };
    return typeof configured.prompt === 'string'
      ? input.agent(configured.prompt, opts)
      : input.agent(configured.prompt, opts);
  };
  const files = parseUnifiedDiff(input.diff);
  const chunks = input.diff
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith('diff --git '));
  const patches = new Map(
    chunks.flatMap((chunk) => {
      const file = parseUnifiedDiff(chunk)[0];
      return file ? [[file.path, chunk] as const] : [];
    }),
  );
  const changedFiles = files.map(({ path, status }) => ({ path, status }));
  let previousProblems: string[] = [];
  for (let revision = 1; revision <= 2; revision++) {
    const context = {
      ...input.context,
      changedFiles,
      previousProblems,
      revision,
    };
    const inventory = await call('inventory', inventoryPrompt, {
      tools: ['read'],
      mcp: [],
      label: `Recap visual inventory ${revision}/2`,
      input: context,
      schema: RecapInventory,
    });
    const narrative = await call('narrative', narrativePrompt, {
      tools: ['read'],
      mcp: [],
      label: `Recap key changes and review focus ${revision}/2`,
      input: { ...context, inventory },
      schema: RecapNarrative,
    });
    const groundingProblems: string[] = [];
    const keyChanges = narrative.keyChanges.map((change) => {
      if (change.files.some((path) => !patches.has(path)))
        groundingProblems.push(
          'Recap key changes must reference files in the supplied diff.',
        );
      for (const annotation of change.annotations) {
        const file = files.find((file) => file.path === annotation.file);
        if (
          !change.files.includes(annotation.file) ||
          !file ||
          (annotation.line !== undefined &&
            !file.hunks.some((hunk) =>
              hunk.lines.some(
                (line) =>
                  line.headLine === annotation.line ||
                  line.baseLine === annotation.line,
              ),
            ))
        )
          groundingProblems.push(
            'Recap annotation must reference a selected file and a real diff line.',
          );
      }
      return {
        ...change,
        diff: change.files.map((path) => patches.get(path)).join('\n'),
      };
    });
    const visuals: z.infer<typeof ReportContent>['visuals'] = [];
    // One browser/preview at a time avoids cross-variant session interference.
    for (const variant of inventory.variants) {
      const screenshotDir = resolve(
        String(input.context.screenshotDir),
        String(input.context.reportId),
        String(revision),
        variant.id,
      );
      await input.steps.step(
        'reviewReport.captureDir',
        { label: `Prepare evidence for ${variant.id}` },
        async () => {
          await mkdir(screenshotDir, { recursive: true });
          return { status: 'done', result: null };
        },
      );
      const capture = await call('capture', capturePrompt, {
        tools: ['read', 'bash'],
        label: `Recap screenshot: ${variant.group} / ${variant.variant} ${revision}/2`,
        input: { ...context, variant, screenshotDir },
        schema: CaptureFor(screenshotDir),
      });
      visuals.push({
        ...capture,
        screenshots: capture.screenshots.map((shot) => ({
          ...shot,
          path: resolve(screenshotDir, shot.path),
        })),
        group: variant.group,
        variant: variant.variant,
        description: variant.description,
      });
    }
    const content = {
      ...narrative,
      keyChanges,
      files: changedFiles,
      ...(input.deliverable === undefined
        ? {}
        : { deliverable: input.deliverable }),
      visuallyReviewable: inventory.variants.length > 0,
      visuals,
      limitations: [
        ...narrative.limitations,
        ...inventory.exclusions,
        ...visuals
          .filter((v) => v.status === 'unavailable')
          .map((v) => `${v.group} / ${v.variant}: ${v.reason}`),
      ],
    };
    const audited = await call(
      'audit',
      `Independently audit this recap against the original immutable diff/deliverable, ticket and repository evidence. Check meaningful changed surfaces are inventoried, each inventory variant has a capture or explicit limitation, key-change summaries and code annotations are accurate, added routes and permission changes are explicit, all review categories are evidence-backed, and the result is easy to review. Missing visual access may remain clearly labelled as unavailable; invented evidence and silently omitted variants are blocking. This is a read-only evidence audit. Capture Steps own browser commands and screenshot creation and receive bash; this audit does not. If existing captures are missing or their unavailable claims are disproven by known available tools, return actionable problems requesting a fresh capture pass. The Workflow uses those problems to run the next capture revision. Do not execute captures here or emit a tool-blocked response merely because this audit has no bash. Return only actionable blocking problems; do not repeat cosmetic preferences.`,
      {
        tools: ['read'],
        mcp: [],
        label: `Recap evidence audit ${revision}/2`,
        input: { ...context, inventory, content },
        schema: RecapAudit,
      },
    );
    previousProblems = [
      ...groundingProblems,
      ...(files.length && !keyChanges.length
        ? ['Include key changes for the supplied code diff.']
        : []),
      ...audited.problems,
    ];
    if (!previousProblems.length) return ReportContent.parse(content);
  }
  throw new Error(
    `Visual recap failed its evidence audit after two passes: ${previousProblems.join('\n')}`,
  );
}
