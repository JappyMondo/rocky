import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { runBoot } from '../run/replay.js';
import { createAgent } from '../run/agent.js';
import { generateReport, reportMarkdown } from './reporter.js';
import { ReportContent } from './schema.js';

const content = {
  title: 'Empty states',
  summary: 'Explains the new empty-state behavior.',
  problems: [{ problem: 'Blank page', solution: 'Show a useful empty state.' }],
  diagrams: [
    {
      title: 'Data flow',
      description: 'The empty path now has a visible result.',
      mermaid: 'flowchart LR\nA[Load] --> B[Empty state]',
    },
  ],
  verification: ['Verified the empty state.'],
  limitations: [],
  visuallyReviewable: true,
  visuals: [
    {
      group: 'Dashboard',
      variant: 'Dark / mobile',
      description: 'No records',
      status: 'captured',
      reason: '',
      screenshots: [{ path: 'mobile.png', caption: 'Mobile empty state' }],
    },
  ],
};
it('requires visual evidence or a reason for each unavailable variant', () => {
  expect(ReportContent.safeParse({ ...content, visuals: [] }).success).toBe(
    false,
  );
  expect(
    ReportContent.safeParse({
      ...content,
      visuals: [{ ...content.visuals[0], screenshots: [] }],
    }).success,
  ).toBe(false);
  expect(
    ReportContent.safeParse({
      ...content,
      visuals: [
        {
          ...content.visuals[0],
          status: 'unavailable',
          screenshots: [],
          reason: 'Preview needs test credentials.',
        },
      ],
    }).success,
  ).toBe(true);
});
it('durably saves grouped evidence and replays without another agent call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-report-'));
  const paths = rockyPaths(root);
  const runId = 'TEST-1-1';
  const p = paths.run(runId);
  const artifacts = new LocalArtifacts(paths);
  try {
    await mkdir(p.screenshotsDir, { recursive: true });
    await writeFile(
      join(p.screenshotsDir, 'mobile.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const run = vi.fn(async () => ({
      text: `<result>${JSON.stringify({ ...content, visuals: [{ ...content.visuals[0], screenshots: [{ path: join(p.screenshotsDir, 'mobile.png'), caption: 'Mobile empty state' }] }] })}</result>`,
      events: [],
      sessionId: 'report',
    }));
    const boot = () =>
      runBoot({
        journalPath: p.journal,
        workflow: async (steps) => {
          const agent = createAgent(steps, {
            snapshotDir: p.snapshotDir,
            cwd: p.dir,
            sessionDir: p.sessionsDir,
            harness: 'fixture',
            harnesses: {
              fixture: { command: 'fixture', env: {}, sessionStorage: 'rocky' },
            },
            adapterFor: () => ({ run, resume: run }),
          });
          const input: Parameters<typeof generateReport>[0] = {
            steps,
            agent,
            agentOptions: {},
            artifacts,
            runId,
            pr: {
              repo: 'app',
              id: '1',
              number: 1,
              url: 'https://github.com/example/app/pull/1',
              headSha: 'a'.repeat(40),
              sourceBranch: 'issue',
              baseBranch: 'main',
              state: 'open',
              draft: true,
            },
            baseSha: 'b'.repeat(40),
            diff: 'actual diff',
            issue: { title: 'Empty state' },
            screenshotDir: p.screenshotsDir,
            workspace: [],
            port: undefined,
          };
          await generateReport(input);
          await generateReport(input);
          return 'completed';
        },
      });
    {
      const result = await boot();
      expect(result.status, JSON.stringify(result)).toBe('finished');
    }
    {
      const result = await boot();
      expect(result.status, JSON.stringify(result)).toBe('finished');
    }
    expect(run).toHaveBeenCalledTimes(1);
    const [report] = await artifacts.listReports(runId);
    expect(report.visuals[0].screenshots[0].id).toMatch(/^s_/);
    const immutable = await artifacts.readScreenshot(
      report.visuals[0].screenshots[0].id,
    );
    await writeFile(
      join(p.screenshotsDir, 'mobile.png'),
      'replaced by a later capture',
    );
    expect(
      (await artifacts.readScreenshot(report.visuals[0].screenshots[0].id))
        .bytes,
    ).toEqual(immutable.bytes);
    const unavailable = {
      ...report,
      limitations: ['Preview unavailable.'],
      visuals: [
        {
          ...report.visuals[0],
          status: 'unavailable' as const,
          reason: 'Missing account.',
          screenshots: [],
        },
      ],
    };
    expect(reportMarkdown(unavailable, 'http://localhost:7625')).toContain(
      'Not captured: Missing account.',
    );
    expect(reportMarkdown(unavailable, 'http://localhost:7625')).toContain(
      '### Limitations',
    );
    await expect(artifacts.saveReport('ANOTHER-1', report)).rejects.toThrow(
      'another Run',
    );
    await expect(
      artifacts.saveReport(runId, {
        ...report,
        id: `r_${'c'.repeat(32)}`,
        visuals: [
          {
            ...report.visuals[0],
            screenshots: [{ id: `s_${'c'.repeat(32)}`, caption: 'Unknown' }],
          },
        ],
      }),
    ).rejects.toThrow('unregistered');
    expect(reportMarkdown(report, 'http://localhost:7625')).toContain(
      '```mermaid',
    );
    await expect(
      artifacts.saveReport(runId, { ...report, summary: 'changed' }),
    ).rejects.toThrow('cannot be overwritten');
    await expect(artifacts.readReport(runId, '../secret')).rejects.toThrow(
      'malformed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
