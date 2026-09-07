import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createWorkflowContext,
  type CheckpointApprovalVerifier,
} from './context.js';
import type { ApprovedCheckpoint } from '@rocky/sdk';
import { newRunHeader } from './header.js';
import { openJournal, type JournalEntry } from './journal.js';
import { runBoot } from './replay.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-context-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const header = newRunHeader({
  runId: 'NG-597-1',
  repo: 'rocky',
  branch: 'ng-597',
  now: '2026-09-07T10:00:00Z',
  issue: {
    identifier: 'NG-597',
    title: 'Immutable',
    description: '',
    labels: ['rocky'],
    url: '',
  },
});

it('names missing external adapters without inventing behavior', async () => {
  await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (runner) => {
      const ctx = createWorkflowContext(runner, header, {
        exec: async () => ({ pid: 1 }),
        changedFiles: async () => [],
      });
      for (const name of [
        'agent',
        'checkpoint',
        'post',
        'scm',
        'linear',
      ] as const) {
        expect(() => ctx[name]).toThrow(`ctx.${name} requires an adapter`);
      }
      return 'merged';
    },
  });
});

it('mints approval capabilities only from this Boot checkpoint answer, including replay', async () => {
  const journalPath = join(dir, 'journal.jsonl');
  let verifier: CheckpointApprovalVerifier | undefined;
  let previous: ApprovedCheckpoint | undefined;
  for (let boot = 0; boot < 2; boot++) {
    await runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = createWorkflowContext(runner, header, {
          exec: async () => ({ pid: 1 }),
          changedFiles: async () => [],
          external: (_steps, approvals) => {
            verifier = approvals;
            return {
              checkpoint: async () => ({
                status: 'done',
                result: { decision: 'approve' as const },
              }),
            };
          },
        });
        const answer = await ctx.checkpoint({ title: 'Merge', body: '' });
        expect(answer.decision).toBe('approve');
        if (answer.decision !== 'approve') throw new Error('expected approval');
        expect(verifier?.(answer)).toBe(true);
        expect(verifier?.({ decision: 'approve' } as ApprovedCheckpoint)).toBe(
          false,
        );
        if (previous) expect(verifier?.(previous)).toBe(false);
        previous = answer;
        return 'merged';
      },
    });
  }
});

it('journals an unjournalled raw checkpoint once and remints approval on replay', async () => {
  const journalPath = join(dir, 'journal.jsonl');
  let effects = 0;
  let prior: ApprovedCheckpoint | undefined;
  for (let boot = 0; boot < 2; boot++) {
    await runBoot({
      journalPath,
      workflow: async (runner) => {
        let verifier: CheckpointApprovalVerifier | undefined;
        const ctx = createWorkflowContext(runner, header, {
          exec: async () => ({ pid: 1 }),
          changedFiles: async () => [],
          external: (_steps, approvals) => {
            verifier = approvals;
            return {
              checkpoint: async () => {
                effects++;
                return { status: 'done', result: { decision: 'approve' } };
              },
            };
          },
        });
        const answer = await ctx.checkpoint({ title: 'Merge', body: '' });
        if (answer.decision !== 'approve') throw new Error('expected approval');
        expect(verifier?.(answer)).toBe(true);
        if (prior) expect(verifier?.(prior)).toBe(false);
        prior = answer;
        return 'merged';
      },
    });
  }
  expect(effects).toBe(1);
  const journal = await openJournal(journalPath);
  expect(
    journal.entries.filter((entry) => entry.step === 'checkpoint'),
  ).toHaveLength(2);
});

it('runs ordinary loops and nested parallel callbacks through the same ctx and replays their Steps', async () => {
  const effects: string[] = [];
  let ready = false;
  const journalPath = join(dir, 'journal.jsonl');
  const boot = () =>
    runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          { ...header, ports: [12345] },
          {
            exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
            changedFiles: async () => {
              effects.push('files');
              return ['a.ts'];
            },
          },
        );
        expect(() => {
          ctx.issue.labels.push('mutated');
        }).toThrow();
        ctx.stage('Code review');
        for (const i of [1, 2]) {
          const files = await ctx.changedFiles();
          if (files.length)
            await ctx.parallel([1, 2], async (item, index) => {
              await new Promise((resolve) =>
                setTimeout(resolve, item === 1 ? 3 : 0),
              );
              await ctx.step('first', () => {
                effects.push(`${i}:${index}`);
                return item;
              });
              return ctx.parallel([item], async (inner) =>
                ctx.step('second', () => inner * 2),
              );
            });
        }
        await runner.step('checkpoint', {}, async () =>
          ready ? { status: 'done', result: null } : { status: 'waiting' },
        );
        return 'merged';
      },
    });
  expect((await boot()).status).toBe('parked');
  const first = [...effects];
  ready = true;
  expect((await boot()).status).toBe('finished');
  expect(effects).toEqual(first);
  const journal = await openJournal(journalPath);
  expect(journal.latest(0)?.stage).toBe('Code review');
  expect(journal.latest(1)?.step).toBe('$parallel');
  expect(journal.latest(4)?.step).toBe('checkpoint');
});

it.each([new Map(), new Date(), { dropped: undefined }, { n: NaN }, () => 1])(
  'fails non-JSON Step values at record time: %j',
  async (value) => {
    const result = await runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          { ...header, ports: [] },
          {
            exec: async () => ({ pid: 1 }),
            changedFiles: async () => [],
          },
        );
        await ctx.step('invalid', () => value);
        return 'merged';
      },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/JSON/) },
    });
  },
);

it('keeps every nested Journal snapshot unchanged when Workflow code mutates returned values across Boots', async () => {
  const journalPath = join(dir, 'journal.jsonl');
  const stepValues: string[][] = [];
  const parallelValues: string[][] = [];
  let effects = 0;
  const boot = () =>
    runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = createWorkflowContext(runner, header, {
          exec: async () => ({ pid: 1 }),
          changedFiles: async () => [],
        });
        const outer = await ctx.parallel(
          [1],
          async () => {
            const inner = await ctx.parallel(
              [1],
              async () => {
                const value = await ctx.step('original', () => {
                  effects++;
                  return { nested: { items: [] as string[] } };
                });
                stepValues.push([...value.nested.items]);
                value.nested.items.push('step mutation');
                await ctx.step('flush Step snapshot', () => null);
                return { nested: { items: [] as string[] } };
              },
              { label: 'inner' },
            );
            const value = inner[0];
            if (!value) throw new Error('missing inner result');
            parallelValues.push([...value.nested.items]);
            value.nested.items.push('parallel mutation');
            await ctx.step('flush parallel snapshot', () => null);
            return value;
          },
          { label: 'outer' },
        );
        outer[0]?.nested.items.push('Workflow mutation');
        await runner.step('checkpoint', {}, async () => ({
          status: 'waiting',
        }));
        return 'merged';
      },
    });
  const inspect = (entries: readonly JournalEntry[]): void => {
    for (const entry of entries) {
      if (entry.status === 'done' && entry.label === 'original') {
        expect(entry.result).toEqual({ nested: { items: [] } });
      }
      if (entry.status === 'done' && entry.label === 'inner') {
        expect(entry.parallel?.results).toEqual([
          { value: { nested: { items: [] } } },
        ]);
      }
      if (entry.status === 'done' && entry.label === 'outer') {
        expect(entry.parallel?.results).toEqual([
          { value: { nested: { items: ['parallel mutation'] } } },
        ]);
      }
      for (const branch of entry.parallel?.branches ?? []) inspect(branch);
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await boot()).status).toBe('parked');
    const journal = await openJournal(journalPath);
    expect(journal.latest(0)?.parallel?.count).toBe(1);
    inspect(journal.entries);
  }
  expect(effects).toBe(1);
  expect(stepValues).toEqual([[], [], []]);
  expect(parallelValues).toEqual([[], [], []]);
});
