import type { VisualRecapOptions } from '@rocky/sdk';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { ScmPr, WorkflowContext, AgentCallOpts } from '@rocky/sdk';
import type { ReviewReport } from '@rocky/local-contracts';
import type { BootContext } from '../run/replay.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { ReportContent } from './schema.js';
import { generateRecapContent } from './recap.js';

export const reportPrompt = `Create a visual review report for a human deciding whether to approve a PR/MR. Use everyday words and one idea per sentence. Keep the introduction under 30 words in at most two sentences. Put technical references in evidence, not the introduction. Explain the original goal, then observable before/after behavior, with compact Mermaid diagrams when useful. This is an explanation of the change, not a code review. Ground every claim in the supplied immutable diff and verified evidence; never substitute changes in another checkout or rely on an agent's claims about a commit.

Inspect the changed code and documentation, and identify actual application UI changes. Backend, configuration, docs and README changes do not require screenshots or a special no-UI section. Capture a document's rendering only when the user explicitly requests that inspection. Inventory all available variants of the affected surfaces: screens, states, themes, breakpoints, roles, feature variants and locales supported by this change. Group the screenshots by surface and label each variant clearly. Capture the actual result for every available variant using the granted browser tools or local rendering commands, including successful cases. You may start a local preview server on the supplied port, but do not edit product files, commit, push, or modify external services. Save images under screenshotDir, use filenames unique to this report, and return paths relative to screenshotDir. Never invent a screenshot. If a variant cannot be exercised, include it as unavailable and explain the exact missing dependency, access, or command in reason. Document incomplete visual coverage in limitations. The report must be honest about any checks you could not perform. Do not use screenshots from an older head as evidence for this revision. Use simple Mermaid labels; no HTML, directives, click handlers, or external assets. The report output must match the supplied JSON schema.`;

export function reportId(
  pr: Pick<ScmPr, 'repo' | 'number' | 'headSha'>,
): string {
  return `r_${createHash('sha256')
    .update(JSON.stringify([pr.repo, pr.number, pr.headSha]))
    .digest('hex')
    .slice(0, 32)}`;
}

export function recapId(input: {
  pr?: Pick<ScmPr, 'repo' | 'number' | 'headSha'>;
  diff?: string;
  deliverable?: string;
  title?: string;
  enhanced?: boolean;
  version?: 1 | 2;
  refreshKey?: string;
}): string {
  if (input.pr && !input.enhanced) return reportId(input.pr);
  const subject = input.pr
    ? [input.pr.repo, input.pr.number, input.pr.headSha]
    : [input.title ?? '', input.diff ?? '', input.deliverable ?? ''];
  return `r_${createHash('sha256')
    .update(
      JSON.stringify([
        input.enhanced ? `visual-recap-v${input.version ?? 2}` : 'report',
        ...subject,
        ...(input.refreshKey ? [input.refreshKey] : []),
      ]),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

export function reportMarkdown(
  report: ReviewReport,
  origin: string,
  images: Record<string, string> = {},
  sharedUrl?: string,
): string {
  const url =
    sharedUrl ??
    `${origin}/runs/${encodeURIComponent(report.runId)}?report=${report.id}`;
  if (report.keyChanges !== undefined)
    return [
      `## ${report.title}`,
      report.summary,
      `[Open visual recap in Rocky](${url})`,
      ...(report.pr ? [`Revision: \`${report.pr.headSha}\``] : []),
      ...(report.visuals.length
        ? [
            `Visual coverage: ${report.visuals.filter((v) => v.status === 'captured').length}/${report.visuals.length} variants captured.`,
          ]
        : []),
      ...report.limitations.map((limitation) => `- ${limitation}`),
    ].join('\n\n');
  return [
    `## ${report.title}`,
    report.summary,
    `[Open visual review report in Rocky](${url})`,
    ...(report.pr ? [`Revision: \`${report.pr.headSha}\``] : []),
    ...report.problems.map((p) => `### ${p.problem}\n\n${p.solution}`),
    ...report.diagrams.map(
      (d) =>
        `### ${d.title}\n\n${d.description}\n\n\`\`\`mermaid\n${d.mermaid}\n\`\`\``,
    ),
    '### Verification',
    ...report.verification.map((v) => `- ${v}`),
    ...report.visuals.map(
      (v) =>
        `### ${v.group} — ${v.variant}\n\n${v.description}\n\n${v.status === 'unavailable' ? `Not captured: ${v.reason}` : v.screenshots.map((s) => `![${s.caption.replaceAll(']', '\\]')}](${images[s.id] ?? `${origin}/api/screenshots/${s.id}`})`).join('\n\n')}`,
    ),
    ...(report.limitations.length
      ? ['### Limitations', ...report.limitations.map((v) => `- ${v}`)]
      : []),
  ].join('\n\n');
}

export async function generateReport(input: {
  steps: BootContext;
  agent: WorkflowContext['agent'];
  agentOptions: AgentCallOpts;
  agents?: VisualRecapOptions['agents'];
  artifacts: LocalArtifacts;
  runId: string;
  pr?: ScmPr;
  pullRequests?: ReviewReport['pullRequests'];
  baseSha?: string;
  diff?: string;
  deliverable?: string;
  title?: string;
  enhanced?: boolean;
  version?: 1 | 2;
  refreshKey?: string;
  workflowEvidence?: unknown;
  issue: unknown;
  screenshotDir: string;
  workspace: unknown;
  workflow?: string;
  previewUrl?: string;
  scope?: unknown;
  port: number | undefined;
}): Promise<ReviewReport> {
  const id = recapId(input);
  const cached = await input.steps.step(
    'reviewReport.cache',
    { label: 'Find report for PR revision' },
    async () => ({
      status: 'done',
      result:
        (await input.artifacts.listReports(input.runId)).find(
          (report) => report.id === id,
        ) ?? null,
    }),
  );
  if (cached) return cached;
  const context = {
    issue: input.issue,
    pr: input.pr ?? null,
    title: input.title ?? null,
    baseSha: input.baseSha ?? null,
    diff: input.diff ?? '',
    deliverable: input.deliverable ?? null,
    screenshotDir: input.screenshotDir,
    workspace: input.workspace,
    port: input.port ?? null,
    workflow: input.workflow ?? null,
    scope: input.scope ?? null,
    reportId: id,
    previewUrl: input.previewUrl ?? null,
    workflowEvidence: input.workflowEvidence ?? null,
  };
  const content = input.enhanced
    ? await generateRecapContent({
        steps: input.steps,
        agent: input.agent,
        agentOptions: input.agentOptions,
        agents: input.agents,
        context,
        diff: input.diff ?? '',
        deliverable: input.deliverable,
        version: input.version,
      })
    : await input.agent(
        { prompt: reportPrompt },
        {
          ...input.agentOptions,
          label: `Visual review report: ${input.pr?.repo ?? 'deliverable'} #${input.pr?.number ?? ''}`,
          schema: ReportContent,
          input: {
            issue: input.issue,
            pr: input.pr,
            baseSha: input.baseSha,
            diff: input.diff,
            screenshotDir: input.screenshotDir,
            workspace: input.workspace,
            port: input.port ?? null,
            workflow: input.workflow ?? null,
            scope: input.scope ?? null,
            reportId: id,
            previewUrl: input.previewUrl ?? null,
          },
        },
      );
  return input.steps.step(
    'reviewReport.save',
    { label: 'Save visual review report' },
    async () => {
      const existing = (await input.artifacts.listReports(input.runId)).find(
        (report) => report.id === id,
      );
      if (existing) return { status: 'done', result: existing };
      const visuals: ReviewReport['visuals'] = [];
      for (const visual of content.visuals) {
        const screenshots = [];
        for (const shot of visual.screenshots) {
          const path = shot.path.startsWith('/')
            ? relative(input.screenshotDir, shot.path)
            : shot.path;
          screenshots.push(
            await input.artifacts.snapshotScreenshot(
              input.runId,
              path,
              shot.caption,
            ),
          );
        }
        visuals.push({ ...visual, screenshots });
      }
      const report: ReviewReport = {
        ...content,
        id,
        runId: input.runId,
        createdAt: new Date().toISOString(),
        ...(input.pullRequests?.length
          ? { pullRequests: input.pullRequests }
          : {}),
        ...(input.pr
          ? {
              pr: {
                repo: input.pr.repo,
                number: input.pr.number,
                url: input.pr.url,
                headSha: input.pr.headSha,
                baseSha: input.baseSha ?? input.pr.headSha,
              },
            }
          : {}),
        visuals,
      };
      await input.artifacts.saveReport(input.runId, report);
      return { status: 'done', result: report };
    },
  );
}
