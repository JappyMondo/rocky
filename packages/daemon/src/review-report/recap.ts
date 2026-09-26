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
import {
  DecisionReview,
  KeyChange,
  ReportContent,
  ReviewFocus,
} from './schema.js';

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
export const DecisionNarrative = RecapNarrative.extend(DecisionReview);

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

export const inventoryPrompt = `Inventory the visual evidence needed for a finished-work recap. Inspect the supplied immutable diff or deliverable and repository context. Identify every meaningful changed screen, route, dialog, role/access state, loading/empty/error/success state, supported theme, breakpoint, locale and feature variant available for the affected surfaces. Backend, configuration, documentation and README changes are not UI changes and do not require screenshots. Inventory actual application UI changes only; a document or diagram capture is appropriate only when the user explicitly requests visual inspection of its rendering. Explain backend behavior with narrative scenarios and a processing diagram. Screenshot counts are evidence coverage, never requirements coverage. Each variant needs a stable ID, group, clear label, description and actionable capture instructions. Inventory only supported combinations, not hypothetical products. Keep exclusions concise, at most five grouped reasons. List exclusions with specific evidence: unchanged, redundant, not visual, or unsupported. Missing access is not an exclusion: inventory that variant so capture reports the limitation. Work read-only. Review previous audit problems when provided.`;

export const narrativePrompt = `Explain the finished work for a human reviewer. Write a guided review for a colleague outside engineering. Use everyday words and short sentences. The reader should understand each page in under a minute, without knowing the codebase. Fewer words alone are not enough: remove abstract phrasing and explain what happens to the person or their data.

Writing rules:
- Aim for at most 18 words per sentence. Use one idea per sentence. Avoid semicolons, stacked clauses and noun-heavy phrases. Do not compress a paragraph into a long sentence to meet a word limit.
- Give each field one job. Do not repeat the same facts across the introduction, decision, risks and evidence.
- title: at most 10 words. goal: explain the original user goal in at most 30 words. Do not put implementation status or risks here.
- summary: explain only the main change in at most 30 words and two short sentences. Put secondary behaviors on their own cards. Leave IDs, file paths, commit hashes, test details and caveats out of this introduction.
- decision.summary: at most 30 words in two short sentences. First say whether the work is ready. Then name the missing item or reason in concrete terms. For example: "One item is still missing. The report has no link to the deployment settings PR." actions: at most four concrete next steps, each at most 20 words.
- behavior: use three to five useful scenarios. Each scenario title is at most eight words. Before and after each use at most 25 words. Prefer concrete examples to descriptions of source internals.
- requirements: give each item a plain-language label of at most eight words. Preserve the complete acceptance criterion verbatim in criterion, exactly once. The viewer puts original wording and evidence behind an expandable control.
- reviewFocus: each title is at most eight words and each summary at most 25 words. Put technical detail in evidence, not the summary. limitations: at most four short bullets, each at most 25 words, for material gaps or agreed checks that were skipped.
- Write short evidence bullets too. Start with the finding, then its source. Put paths, step keys and revisions here or in verification. Use at most 45 words per evidence or verification bullet.
- Prefer "The automated checks passed" to "The reviewed revision has a passing CI receipt", "Rewriting old data may slow incoming readings" to "Enforcement can compete with ingestion", and "The settings PR is not linked" to "Companion delivery is not evidenced". Explain delayed cleanup as "Old data is removed in the background". Avoid "effective window", "established", "enforcement", "evidenced", "ingestion", "incidental", "asynchronous" and "outstanding" in main prose; these hide simple ideas. Requirement labels must also make sense without opening the original wording.
- Use phrases such as "check results", "deployment settings PR", "old data", and "rewrite existing data". Avoid unexplained terms such as "receipt", "companion delivery", "materialization", "current-head", "load-bearing", and "waived" in reader-facing prose. Say "The running app was not tested, as agreed" when that is the evidence. Keep technical names where needed in source references.

Grounding:
Inspect the supplied diff, ticket, clarified scope and repository evidence. For every supplied acceptance criterion, copy its wording into requirements exactly once and assess it as supported, gap, unverified, or waived. Supported means evidence supports the implementation; it does not mean the running app was tested. A waiver must cite the user's decision. Explain what would settle each unverified requirement. Account for every required repository and PR. A local commit or configuration value does not prove the required PR exists. Ready requires supported criteria or explicit waivers and no unresolved delivery gap.
Use workflowEvidence to distinguish source inspection, command/CI results, agent-reported checks, older revisions and user decisions. A linear-comment receipt confirms that the exact deliverable was posted; a linear-state receipt confirms the configured issue state was set. Do not mark those delivery requirements unverified when their matching receipts are present. Prefer the final check for the reviewed revision over superseded failures. Qualify agent reports as claims, not proof of execution. Keep precise step keys and revisions in evidence and verification, never in the introduction.
The supplied visuals are completed capture results. Inspect available images and reconcile claims with them. Set ui.changed only for actual application UI changes. Backend, configuration, docs and README changes do not need screenshots or a special no-UI section or caveat. ui.summary is internal when changed is false. Keep product failures separate from failures to collect evidence.

Review pages:
The viewer shows goal, before/after behavior, relevant screenshots, processing diagrams, requirements, risks/checks, then the decision. Do not cram the whole review into any field. Include a brief problem/solution overview as supporting detail. For asynchronous work, retries, state changes or data lifecycle, add a simple Mermaid diagram that explains what happens. Prefer top-to-bottom flows that fit a narrow page, with about eight nodes and short labels. Split a complex flow into up to three focused diagrams. Each diagram description must be at most 30 words in two short sentences. Put conditions on the relevant arrows or decision nodes; do not repeat the diagram as a paragraph. Link split flows explicitly: a diagram must not bypass recovery, wait, skip or error paths merely because another diagram describes them. Show recovery checks before resubmitting work. Use quoted labels, no HTML, directives or click handlers. Explain that it is a model based on source, not a test result.
Assess all eight reviewFocus categories once: security, permissions, routes, data, compatibility, operations, testing, other. Use attention for material risks or unresolved questions, verified only with evidence, and not-applicable with a reason. Only attention summaries appear by default; supporting checks are expandable. Name changed endpoints and access rules in evidence when relevant. Do not invent risk to fill a category or imply exhaustive security certification.
Select only useful keyChanges. Rocky builds changedFiles, content.files and attached diffs from the primary supplied diff. Other repositories are covered by workflowEvidence.repositories, requirements and reviewFocus; do not put files outside changedFiles into keyChanges. Give each a short plain-language summary and exact paths from changedFiles. Rocky attaches actual diffs; never generate code diffs. Annotations must use actual changed lines. For a non-code deliverable, return no keyChanges and assess accuracy, completeness and limitations. Work read-only. Resolve previous audit problems if supplied.`;

export const capturePrompt = `Capture the requested visual variant for this exact revision. Use available browser tools or local rendering commands. First check agent-browser via bash and read agent-browser skills get core; a browser MCP server and workspace Playwright installation are not required when this CLI is available. Use the dedicated ROCKY_BROWSER_SESSION and close it after capture. When previewUrl is supplied, it points to the exact deliverable already displayed in Rocky: open it, locate the candidate body, activate its Render diagram controls, wait for the diagrams and inspect the rendered output before capturing the requested section. This is a local preview, not proof of publication in Linear. Do not capture duplicate transcript copies or raw diagram source as rendered evidence. When scope.environment.endpoints is supplied, use those verified service URLs for application capture. Rocky owns their startup and shutdown; do not start or stop those servers. If neither previewUrl nor verified endpoints is supplied, inspect configuration and start a local preview on the reserved port if needed. Reuse an already-running matching preview when possible. Capture actual screenshots of the requested states; include before/after views when the baseline can be shown reliably. Save new images under screenshotDir using reportId, revision and variant ID in the filename. Never reuse an old-head screenshot. Keep repository files, git and external services unchanged; use temporary files for preview/render inputs, and clean up a server you start before finishing. Inspect every image for readable text, clipping, loading placeholders and correct state before returning it. Use consistent viewport, scale and crop for comparable before/after views, ordered before then after. Return every screenshot with a short informative caption; put shared provenance in the description. If required capture cannot be performed because no browser or renderer is available, stop using the runner's <blocked> envelope so configuration can be fixed before any more capture Steps run. For a variant-specific limitation despite functioning tools (for example an inaccessible role or unsupported state), return status unavailable, no screenshots, and its concrete reason. Never fabricate evidence, substitute a mockup, or claim an unperformed render passed. Rocky hosts these screenshots itself.`;

export const auditPrompt = `Independently audit this recap against the original immutable diff/deliverable, ticket and repository evidence. Check meaningful changed surfaces are inventoried, each inventory variant has a capture or explicit limitation, key-change summaries and code annotations are accurate, added routes and permission changes are explicit, all review categories are evidence-backed, and the result is easy to review. Rocky builds content.files and attached key-change diffs from the primary supplied diff only; those fields are not writer-editable. Review companion repository changes through workflowEvidence.repositories, requirements and reviewFocus. Never demand companion files in the primary changedFiles list or keyChanges. Key-change groups are selective summaries, not an exhaustive listing of every changed file. Missing visual access may remain clearly labelled as unavailable; invented evidence and silently omitted variants are blocking. This is a read-only evidence audit. Capture Steps own browser commands and screenshot creation and receive bash; this audit does not. If existing captures are missing or their unavailable claims are disproven by known available tools, return actionable problems requesting a fresh capture pass. The Workflow uses those problems to run the next capture revision. Do not execute captures here or emit a tool-blocked response merely because this audit has no bash. Return only actionable blocking problems. Plain language and manageable reading length are requirements, not cosmetic preferences. Reject dense introductions, diagram descriptions over 30 words, unexplained jargon, repeated paragraphs, missing goal or short requirement labels, and prose that exceeds the writer's word limits. Exact original acceptance criteria and source references are exempt. The reader must understand the goal, change, main risk and next action without opening evidence. Require short separate statements, not a compressed sentence full of semicolons. Do not demand caveats or source IDs in the introduction; those belong in evidence or the risks/checks page. Check every explicit acceptance criterion has one assessment with evidence and every required repository has a delivery status. Require concrete before/after behavior and an explanatory processing diagram for complex stateful or asynchronous changes. Check the final CI receipt for the exact revision and distinguish agent claims from execution evidence. Inspect the attached images, not just filenames or captions. Reject stale claims that captures or supplied check results are missing. Documentation captures are not UI tests or proof of backend behavior. An honestly reported product/delivery gap may remain in the report with a needs-attention or blocked decision; the recap itself must not hide it. When diagrams split a process, trace their connecting paths against source. A separate recovery diagram does not excuse a main diagram that resubmits work without checking earlier requests. Reject misleading arrows even if the prose elsewhere explains the exception. Keep the decision understandable without opening source or transcripts.`;

/** A recap audit found a repairable deliverable defect, not a runtime failure. */
export class RecapAuditError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Visual recap failed its evidence audit after two passes: ${problems.join('\n')}`,
    );
    this.name = 'RecapAuditError';
  }
}

/** Works across the separately-bundled Run worker and flow-runtime modules. */
export function isRecapAuditError(error: unknown): error is RecapAuditError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'RecapAuditError' &&
    Array.isArray((error as { problems?: unknown }).problems) &&
    (error as { problems: unknown[] }).problems.every(
      (problem) => typeof problem === 'string',
    )
  );
}

/** Keep long explanatory paragraphs out of the guided pages, even if an auditor overlooks them. */
export function recapReadabilityProblems(content: {
  diagrams: { title: string; description: string }[];
}) {
  return content.diagrams
    .filter((diagram) => diagram.description.trim().split(/\s+/u).length > 30)
    .map(
      (diagram) =>
        `Shorten the description of "${diagram.title}" to at most 30 words. Put conditions in the diagram or split it into another page.`,
    );
}

/** Multi-agent authoring with explicit coverage and an independent final audit. */
export async function generateRecapContent(input: {
  steps: BootContext;
  agent: WorkflowContext['agent'];
  agentOptions: AgentCallOpts;
  agents?: Record<RecapAgentRole, (input: unknown) => ConfiguredAgent>;
  context: Record<string, unknown>;
  diff: string;
  deliverable?: string;
  version?: 1 | 2;
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
  const version = input.version ?? 2;
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
    const writeNarrative = (visuals: unknown) =>
      call('narrative', narrativePrompt, {
        tools: ['read'],
        mcp: [],
        label: `Recap key changes and review focus ${revision}/2`,
        input: { ...context, inventory, visuals },
        schema: version === 2 ? DecisionNarrative : RecapNarrative,
      });
    const earlyNarrative = version === 1 ? await writeNarrative([]) : undefined;
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
    const narrative = earlyNarrative ?? (await writeNarrative(visuals));
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
        ...(version === 1 ? inventory.exclusions : []),
        ...visuals
          .filter((v) => v.status === 'unavailable')
          .map((v) => `${v.group} / ${v.variant}: ${v.reason}`),
      ],
    };
    const audited = await call('audit', auditPrompt, {
      tools: ['read'],
      mcp: [],
      label: `Recap evidence audit ${revision}/2`,
      input: { ...context, inventory, content },
      schema: RecapAudit,
    });
    const evidence = input.context.workflowEvidence as
      { scopeDecision?: { acceptanceCriteria?: string[] } } | undefined;
    const criteria = evidence?.scopeDecision?.acceptanceCriteria ?? [];
    const decisionNarrative =
      version === 2 ? DecisionNarrative.parse(narrative) : undefined;
    const assessed = decisionNarrative?.requirements ?? [];
    if (
      version === 2 &&
      criteria.some(
        (criterion) =>
          assessed.filter((r) => r.criterion === criterion).length !== 1,
      )
    )
      groundingProblems.push(
        'Assess every supplied acceptance criterion exactly once, preserving its wording.',
      );
    if (
      version === 2 &&
      decisionNarrative?.decision.status === 'ready' &&
      assessed.some((requirement) =>
        ['gap', 'unverified'].includes(requirement.status),
      )
    )
      groundingProblems.push(
        'A recap with gap or unverified requirements cannot be marked ready for handoff.',
      );
    previousProblems = [
      ...groundingProblems,
      ...(version === 2 ? recapReadabilityProblems(content) : []),
      ...(files.length && !keyChanges.length
        ? ['Include key changes for the supplied code diff.']
        : []),
      ...audited.problems,
    ];
    if (!previousProblems.length) return ReportContent.parse(content);
  }
  throw new RecapAuditError(previousProblems);
}
