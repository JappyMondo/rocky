import type { ReviewReport } from '@rocky/local-contracts';
import type { JournalEntry } from './journal.js';

/** Recover a pre-guard approval only from the reports published for that checkpoint. */
export function legacyRecapRecoveryMessage(input: {
  workflow: {
    settings?: { recapDecisionVersion?: 1 };
    nodes?: { type: string }[];
  };
  title: string;
  entries: readonly JournalEntry[];
  reports: readonly ReviewReport[];
}): string | undefined {
  if (
    input.title !== 'Approve this change?' ||
    input.workflow.settings?.recapDecisionVersion ||
    !input.workflow.nodes?.some((node) => node.type === 'delivery.approval')
  )
    return undefined;

  const reports = new Map(input.reports.map((report) => [report.id, report]));
  const latest = new Map<string, { repo: string; report: ReviewReport }>();
  for (const entry of input.entries) {
    if (entry.step !== 'reviewReport.publish' || entry.status !== 'done')
      continue;
    const receipt = entry.result;
    if (!receipt || typeof receipt !== 'object' || !('reportId' in receipt))
      continue;
    const report = reports.get(String(receipt.reportId));
    if (
      !report?.pr ||
      ('headSha' in receipt && receipt.headSha !== report.pr.headSha)
    )
      continue;
    latest.set(report.pr.repo, { repo: report.pr.repo, report });
  }
  const unresolved = [...latest.values()].flatMap(({ repo, report }) => {
    const gaps = (report.requirements ?? []).filter(
      (requirement) =>
        requirement.status === 'gap' || requirement.status === 'unverified',
    );
    if (report.decision?.status === 'ready' && gaps.length === 0) return [];
    return [
      `${repo}: ${report.decision?.summary ?? 'The recap has unresolved requirements.'}`,
      ...gaps.map((gap) => `${gap.status}: ${gap.criterion}`),
      ...(report.decision?.actions ?? []),
    ];
  });
  return unresolved.length
    ? `Rocky recap recovery: The published review report still requires work. Repair the deliverable and verify it again.\n${unresolved.join('\n').slice(0, 8000)}`
    : undefined;
}
