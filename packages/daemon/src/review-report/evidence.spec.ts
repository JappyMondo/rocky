import { expect, it } from 'vitest';
import type { JournalEntry } from '../run/journal.js';
import {
  recapPullRequests,
  recapRepositoryEvidence,
  recapWorkflowEvidence,
} from './evidence.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('links every repository from the latest SCM receipt and ignores agent claims', () => {
  const pr = (repo: string, number: number, headSha = 'a'.repeat(40)) => ({
    repo,
    number,
    headSha,
    url: `https://gitlab.com/example/${repo}/-/merge_requests/${number}`,
  });
  const entry = (seq: number, step: string, result: unknown): JournalEntry => ({
    v: 1,
    seq,
    boot: 1,
    status: 'done',
    startedAt: '2026-09-15T08:00:00Z',
    step,
    result,
  });
  expect(
    recapPullRequests([
      entry(0, 'scm.openPr:app:hash', pr('app', 1)),
      entry(1, 'scm.openPr:config:hash', pr('config', 2)),
      entry(2, 'scm.updateBranch:app:hash', {
        pr: pr('app', 1, 'b'.repeat(40)),
      }),
      entry(3, 'agent', pr('invented', 3)),
    ]),
  ).toEqual([pr('app', 1, 'b'.repeat(40)), pr('config', 2)]);
});

it('retains final revision CI and clarified criteria without converting agent claims into receipts', () => {
  const entry = (seq: number, step: string, result: unknown): JournalEntry => ({
    v: 1,
    seq,
    step,
    status: 'done',
    boot: 1,
    startedAt: '2026-09-15T08:00:00Z',
    result,
  });
  const result = recapWorkflowEvidence(
    [
      entry(1, 'agent', {
        status: 'clear',
        acceptanceCriteria: ['Use 28 days.'],
      }),
      entry(2, 'scm:waitForCi', { status: 'failed', headSha: 'old' }),
      entry(3, 'agent', { summary: '86 tests passed.' }),
      entry(4, 'scm:waitForCi', { status: 'passed', headSha: 'new' }),
      entry(5, 'reviewReport.save', { summary: 'Old recap.' }),
    ],
    'new',
  );
  expect(result.scopeDecision?.acceptanceCriteria).toEqual(['Use 28 days.']);
  expect(result.receipts.map((r) => [r.stepKey, r.currentRevision])).toEqual([
    ['2', false],
    ['4', true],
  ]);
  expect(result.agentReports).toEqual([
    expect.objectContaining({
      stepKey: '3',
      evidenceType: 'agent-reported; not an execution receipt',
    }),
  ]);
});

it('labels CI receipts with their repository so companion CI is not mistaken for an older primary revision', () => {
  const result = recapWorkflowEvidence(
    [
      {
        v: 1,
        seq: 1,
        boot: 1,
        step: 'scm.waitForCi:settings:hash',
        status: 'done',
        startedAt: '2026-09-15T08:00:00Z',
        result: { status: 'passed', headSha: 'companion' },
      },
    ],
    'primary',
  );
  expect(result.receipts).toEqual([
    expect.objectContaining({
      repository: 'settings',
      currentRevision: false,
      revision: 'companion',
    }),
  ]);
});

it('distinguishes an unpushed companion commit from remote delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recap-evidence-'));
  const execute = promisify(execFile);
  const git = (cwd: string, ...args: string[]) =>
    execute('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  try {
    await git(root, 'init', '--bare', 'remote.git');
    await git(root, 'clone', 'remote.git', 'config');
    const dir = join(root, 'config');
    await git(dir, 'config', 'user.name', 'Test');
    await git(dir, 'config', 'user.email', 'test@example.invalid');
    await git(dir, 'checkout', '-b', 'main');
    await writeFile(join(dir, 'retention.txt'), '1\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'Baseline');
    await git(dir, 'push', 'origin', 'main');
    await git(dir, 'checkout', '-b', 'issue-1');
    await writeFile(join(dir, 'retention.txt'), '28\n');
    await git(dir, 'commit', '-am', 'Use 28 days');
    const [evidence] = await recapRepositoryEvidence({
      workspaceDir: root,
      branch: 'issue-1',
      members: [{ name: 'config', path: 'config', baseBranch: 'main' }],
    });
    expect(evidence).toMatchObject({
      repository: 'config',
      clean: true,
      remoteBranchHead: null,
      changedFiles: 'M\tretention.txt',
    });
    expect('diff' in evidence && evidence.diff).toContain('+28');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
