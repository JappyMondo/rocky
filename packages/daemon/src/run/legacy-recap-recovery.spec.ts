import { expect, it } from 'vitest';
import type { ReviewReport } from '@rocky/local-contracts';
import type { JournalEntry } from './journal.js';
import { legacyRecapRecoveryMessage } from './legacy-recap-recovery.js';

const workflow = {
  settings: {},
  nodes: [{ type: 'delivery.approval' }],
};
const title = 'Approve this change?';
const report = (
  id: string,
  status: 'ready' | 'needs-attention',
  repo = 'fixture',
) =>
  ({
    id,
    pr: { repo, headSha: 'a'.repeat(40) },
    decision: {
      status,
      summary: status === 'ready' ? 'Ready.' : 'A check is still missing.',
      actions: status === 'ready' ? [] : ['Run the missing check.'],
    },
    requirements: [
      {
        criterion: 'The package can be installed.',
        status: status === 'ready' ? 'supported' : 'unverified',
        evidence: ['The install result was not recorded.'],
      },
    ],
  }) as ReviewReport;
const published = (id: string, headSha = 'a'.repeat(40)) =>
  ({
    step: 'reviewReport.publish',
    status: 'done',
    result: { reportId: id, headSha },
  }) as JournalEntry;

it('routes a published non-ready legacy recap into Rocky recovery', () => {
  const message = legacyRecapRecoveryMessage({
    workflow,
    title,
    entries: [published('first')],
    reports: [report('first', 'needs-attention')],
  });
  expect(message).toContain('Rocky recap recovery:');
  expect(message).toContain('A check is still missing.');
  expect(message).toContain('The package can be installed.');
});

it('uses the latest published report for each repository', () => {
  const input = {
    workflow,
    title,
    entries: [published('old'), published('current')],
    reports: [report('old', 'needs-attention'), report('current', 'ready')],
  };
  expect(legacyRecapRecoveryMessage(input)).toBeUndefined();
  expect(
    legacyRecapRecoveryMessage({
      ...input,
      entries: [published('current'), published('old')],
    }),
  ).toContain('A check is still missing.');
});

it('does not use reports from another head or a newer guarded workflow', () => {
  const input = {
    workflow,
    title,
    entries: [published('old', 'b'.repeat(40))],
    reports: [report('old', 'needs-attention')],
  };
  expect(legacyRecapRecoveryMessage(input)).toBeUndefined();
  expect(
    legacyRecapRecoveryMessage({
      ...input,
      entries: [published('old')],
      workflow: {
        ...workflow,
        settings: { recapDecisionVersion: 1 as const },
      },
    }),
  ).toBeUndefined();
});

it('keeps a second repository gap visible when the lead is ready', () => {
  const message = legacyRecapRecoveryMessage({
    workflow,
    title,
    entries: [published('lead'), published('companion')],
    reports: [
      report('lead', 'ready'),
      report('companion', 'needs-attention', 'companion'),
    ],
  });
  expect(message).toContain('companion: A check is still missing.');
});

it('recovers a published recap without a readiness decision', () => {
  const undecided = report('undecided', 'ready');
  delete undecided.decision;
  expect(
    legacyRecapRecoveryMessage({
      workflow,
      title,
      entries: [published('undecided')],
      reports: [undecided],
    }),
  ).toContain('The recap has unresolved requirements.');
});
