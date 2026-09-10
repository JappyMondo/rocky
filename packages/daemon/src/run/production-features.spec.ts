import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import type { AgentHarnessInvocation } from './agent.js';
import type { ScmPr, Workflow } from '@rocky/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { newRepositoryProfile } from '../config/profiles.js';
import { parseInstanceConfig } from '../config/schema.js';
import { writeCredentials } from '../config/store.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { appendEntry } from './journal.js';
import { newRunHeader, writeRunHeader } from './header.js';
import { createProductionRuntime } from './production.js';
import type { BootRequest } from './worker.js';

const spies = vi.hoisted(() => ({
  load: vi.fn(),
  checkpoint: vi.fn(),
  comment: vi.fn(),
  postReport: vi.fn(),
  revision: vi.fn(),
  finish: vi.fn(),
  upload: vi.fn(),
  agent: vi.fn(),
}));
vi.mock('./loading/loader.js', () => ({ loadSnapshotWorkflow: spies.load }));
vi.mock('../review-report/workspace.js', () => ({
  reviewRevision: spies.revision,
}));
vi.mock('../linear/client.js', () => ({
  RockyLinearClient: class {
    uploadFile = spies.upload;
  },
}));
vi.mock('../linear/mirror.js', () => ({
  LinearRunMirror: class {
    start = async () => undefined;
    status = () => undefined;
    settle = async () => undefined;
    flushStatus = async () => undefined;
    finish = spies.finish;
    comment = spies.comment;
  },
}));
vi.mock('../scm/index.js', async (original) => {
  const actual = await original<typeof import('../scm/index.js')>();
  const adapter = (input: { repo: { id: string }; signal: AbortSignal }) => ({
    repo: input.repo,
    signal: input.signal,
    openPr: async () => pr,
    markDraft: async () => ({ ...pr, draft: false }),
    postReviewReport: spies.postReport,
  });
  return {
    ...actual,
    runPreflight: async () => undefined,
    createGitHubScm: adapter,
    createGitLabScm: adapter,
  };
});
const pr: ScmPr = {
  id: 'pr-42',
  repo: 'app',
  number: 42,
  url: 'https://github.com/example/app/pull/42',
  headSha: 'a'.repeat(40),
  baseBranch: 'main',
  sourceBranch: 'ng-700',
  draft: false,
  state: 'open',
};
const content = {
  title: 'Ticket clarity before implementation',
  summary: 'Questions are answered before editing begins.',
  problems: [
    { problem: 'Unclear tickets', solution: 'Clarify requirements first.' },
  ],
  diagrams: [
    {
      title: 'Processing',
      description: 'The question loop precedes work.',
      mermaid: 'flowchart LR\n Ticket --> Clarify --> Work',
    },
  ],
  verification: ['Exercised the question loop.'],
  limitations: [],
  visuallyReviewable: true,
  visuals: [
    {
      group: 'Run view',
      variant: 'Desktop',
      description: 'The question panel.',
      status: 'captured',
      reason: '',
      screenshots: [{ path: 'question.png', caption: 'Questions' }],
    },
  ],
};
const roots: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  spies.revision.mockResolvedValue({
    headSha: pr.headSha,
    baseSha: 'b'.repeat(40),
    diff: '+clarify',
  });
  spies.upload.mockResolvedValue({
    assetUrl: 'https://uploads.example.test/question.png',
  });
  spies.agent.mockResolvedValue({
    text: `<result>${JSON.stringify(content)}</result>`,
    events: [],
    sessionId: 'fixture-session',
  });
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(workflow: Workflow) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-features-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const profile = newRepositoryProfile({
    id: 'app',
    remote: 'https://github.com/example/app.git',
  });
  profile.settings.secretEnv = ['GITHUB_TOKEN'];
  const run = newRunHeader({
    runId: 'NG-700-1',
    repo: 'app',
    branch: 'ng-700',
    trigger: 'linear.onDelegate',
    now: '2026-09-10T10:00:00Z',
    issue: {
      identifier: 'NG-700',
      title: 'Clarify first',
      description: '',
      labels: [],
      url: 'https://linear.app/issue/NG-700',
    },
    profile,
  });
  run.linear = {
    issueId: 'issue',
    teamId: 'team',
    organizationId: 'org',
    appUserId: 'agent',
    sessionId: 'session',
  };
  run.execution = {
    source: 'repository',
    sourceCommit: 'frozen',
    reviewReports: true,
    trigger: { kind: 'linear.onDelegate' },
    members: [
      {
        name: 'app',
        path: 'app',
        lead: true,
        url: 'https://github.com/example/app.git',
        baseBranch: 'main',
      },
    ],
  };
  await writeRunHeader(paths, run);
  await writeCredentials(paths, {
    linear: { accessToken: 'fixture' },
    repos: { app: { GITHUB_TOKEN: 'fixture' } },
  });
  await mkdir(paths.run(run.runId).screenshotsDir, { recursive: true });
  await writeFile(
    join(paths.run(run.runId).screenshotsDir, 'question.png'),
    Buffer.from('89504e470d0a1a0a0000', 'hex'),
  );
  spies.load.mockResolvedValue(workflow);
  const records = new Map<string, unknown>();
  const request = vi.fn(async (message: BootRequest) => {
    if (message.kind === 'control-get') return records.get(message.key);
    if (message.kind === 'control-put') {
      records.set(message.key, message.value);
      return undefined;
    }
    if (message.kind === 'append')
      return appendEntry(
        paths.run(run.runId).journal,
        message.entry,
        message.options,
      );
    if (message.kind === 'workspace') return undefined;
    if (message.kind === 'checkpoint') return spies.checkpoint(message);
    throw new Error(`Unexpected request ${message.kind}`);
  });
  const runtime = createProductionRuntime({
    paths,
    config: () => parseInstanceConfig({}),
    request,
    adapterFor: () => ({ run: spies.agent, resume: spies.agent }),
  });
  return { paths, run, runtime, request };
}

it.each(['question', 'checkpoint'] as const)(
  'wires production %s through parent IPC and resumes its durable answer',
  async (kind) => {
    const completed = vi.fn();
    const f = await fixture(async (ctx) => {
      const answer = await ctx[kind]({
        title: 'Which behavior?',
        body: 'Choose the required behavior.',
      });
      completed(answer);
      return 'completed';
    });
    spies.checkpoint
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValueOnce({
        status: 'done',
        result: { decision: 'steer', message: 'Preserve existing behavior.' },
      });
    try {
      const first = await f.runtime.boot(
        f.run,
        'run',
        new AbortController().signal,
      );
      expect(first, JSON.stringify(first)).toMatchObject({
        status: 'parked',
        reason: kind,
      });
      expect(completed).not.toHaveBeenCalled();
      expect(spies.checkpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'checkpoint',
          stepKey: '2',
          request: expect.objectContaining({
            title: 'Which behavior?',
            ...(kind === 'question' ? { kind: 'question' } : {}),
          }),
        }),
      );
      await expect(
        f.runtime.boot(f.run, 'run', new AbortController().signal),
      ).resolves.toMatchObject({ status: 'finished' });
      expect(completed).toHaveBeenCalledWith(
        kind === 'question'
          ? { answer: 'Preserve existing behavior.' }
          : { decision: 'steer', message: 'Preserve existing behavior.' },
      );
    } finally {
      await f.runtime.close();
    }
  },
);

it('automatically saves visual evidence and posts the same report to Linear and a ready PR', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.comment('Agreed scope: clarify first.');
    await ctx.scm.openPr({
      title: 'Clarify first',
      body: 'Explanation',
      draft: false,
    });
    return 'completed';
  });
  try {
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'finished',
    });
    const [report] = await new LocalArtifacts(f.paths).listReports(f.run.runId);
    expect(report).toMatchObject({
      title: content.title,
      pr: { headSha: pr.headSha },
      visuals: [
        {
          group: 'Run view',
          screenshots: [{ id: expect.stringMatching(/^s_/) }],
        },
      ],
    });
    expect(spies.revision).toHaveBeenCalledTimes(3);
    expect(spies.upload).toHaveBeenCalledTimes(1);
    expect(spies.postReport).toHaveBeenCalledWith(
      pr,
      expect.stringContaining('```mermaid'),
      `${f.run.runId}:${report.id}`,
    );
    const markdown = spies.postReport.mock.calls[0][1];
    expect(markdown).toContain('https://uploads.example.test/question.png');
    expect(markdown).toContain(`/runs/${f.run.runId}?report=${report.id}`);
    expect(spies.comment).toHaveBeenCalledWith(`report:${report.id}`, markdown);
    expect(spies.comment).toHaveBeenCalledWith(
      expect.any(String),
      'Agreed scope: clarify first.',
    );
    await f.runtime.boot(f.run, 'run', new AbortController().signal);
    expect(spies.agent).toHaveBeenCalledTimes(1);
    expect(spies.postReport).toHaveBeenCalledTimes(1);
  } finally {
    await f.runtime.close();
  }
});

it.each(['rejected', 'exhausted'] as const)(
  'reports the terminal %s outcome without inventing a change summary',
  async (outcome) => {
    const f = await fixture(async () => outcome);
    try {
      expect(
        await f.runtime.boot(f.run, 'run', new AbortController().signal),
      ).toMatchObject({ status: 'finished', outcome });
      expect(spies.finish).toHaveBeenCalledWith(
        { kind: outcome === 'rejected' ? 'rejected' : 'giveUp' },
        { changedSummary: 'Rocky Run finished.' },
      );
    } finally {
      await f.runtime.close();
    }
  },
);

it.each(['empty', 'head changed'])(
  'leaves a draft unready when revision validation fails: %s',
  async (failure) => {
    const f = await fixture(async (ctx) => {
      await ctx.scm.markDraft({ ...pr, draft: true }, false);
      return 'completed';
    });
    if (failure === 'empty')
      spies.revision.mockRejectedValueOnce(new Error('No committed changes'));
    else
      spies.revision
        .mockResolvedValueOnce({
          headSha: pr.headSha,
          baseSha: 'b'.repeat(40),
          diff: '+clarify',
        })
        .mockRejectedValueOnce(new Error('The PR head changed'));
    try {
      expect(
        await f.runtime.boot(f.run, 'run', new AbortController().signal),
      ).toMatchObject({
        status: 'failed',
        error: {
          message: expect.stringContaining(
            failure === 'empty' ? 'No committed' : 'head changed',
          ),
        },
      });
      expect(spies.postReport).not.toHaveBeenCalled();
      expect(spies.finish).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'failed' }),
        expect.any(Object),
      );
    } finally {
      await f.runtime.close();
    }
  },
);

it.each(['profile', 'token', 'remote'] as const)(
  'fails visibly for missing or invalid %s before starting an agent',
  async (failure) => {
    const f = await fixture(async (ctx) => {
      await ctx.agent({ prompt: 'Inspect.' }, { label: 'Inspect' });
      return 'completed';
    });
    if (failure === 'profile') f.run.profile = undefined;
    else if (failure === 'token')
      await writeCredentials(f.paths, {
        linear: { accessToken: 'fixture' },
        repos: {},
      });
    else {
      if (!f.run.execution) throw new Error('Missing fixture execution');
      f.run.execution.members[0].url = 'https://example.test/unsupported.git';
    }
    await writeRunHeader(f.paths, f.run);
    try {
      expect(
        await f.runtime.boot(f.run, 'run', new AbortController().signal),
      ).toMatchObject({ status: 'failed' });
      expect(spies.agent).not.toHaveBeenCalled();
    } finally {
      await f.runtime.close();
    }
  },
);

it('carries refined scope into a GitLab report and registers nested native transcripts', async () => {
  const scope = {
    status: 'clear',
    scope: 'Preserve existing records',
    summary: 'Scope is clear',
  };
  const f = await fixture(async (ctx) => {
    await ctx.parallel([1, 2], async () =>
      ctx.agent(
        { prompt: 'Clarify' },
        {
          label: 'Clarify',
          schema: z.object({ status: z.literal('clear'), scope: z.string() }),
        },
      ),
    );
    await ctx.agent(
      { prompt: 'Clarify' },
      {
        label: 'Clarify',
        schema: z.object({ status: z.literal('clear'), scope: z.string() }),
      },
    );
    await ctx.scm.markDraft({ ...pr, draft: true }, false);
    return 'completed';
  });
  if (!f.run.execution || !f.run.profile)
    throw new Error('Missing fixture snapshot');
  f.run.execution.members[0].url = 'https://gitlab.com/example/app.git';
  f.run.profile.settings.secretEnv = ['GITLAB_TOKEN'];
  await writeCredentials(f.paths, {
    linear: { accessToken: 'fixture' },
    repos: { app: { GITLAB_TOKEN: 'fixture' } },
  });
  await writeRunHeader(f.paths, f.run);
  spies.agent.mockImplementation(async (input: AgentHarnessInvocation) => {
    await mkdir(dirname(input.transcriptPath), { recursive: true });
    await writeFile(input.transcriptPath, 'native transcript');
    input.onConfiguration?.({ model: 'vendor/resolved', variant: 'high' });
    input.onEvent?.(
      { kind: 'text', text: 'Inspecting requirements' },
      'fixture-session',
    );
    input.onEvent?.({ kind: 'tool-call', name: 'read' }, 'fixture-session');
    return {
      text: `<result>${JSON.stringify(input.prompt.includes('Create a visual review report') ? content : scope)}</result>`,
      events: [],
      sessionId: 'fixture-session',
    };
  });
  try {
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'finished',
    });
    const reportCall = spies.agent.mock.calls
      .map((call) => call[0] as AgentHarnessInvocation)
      .find((input) => input.prompt.includes('Create a visual review report'));
    expect(reportCall?.prompt).toContain('Preserve existing records');
    expect(
      await new LocalArtifacts(f.paths).transcript(f.run.runId, '2/0/0'),
    ).toBeTruthy();
    expect(spies.postReport).toHaveBeenCalledTimes(1);
  } finally {
    await f.runtime.close();
  }
});

it('reuses an already published report if the same head is marked ready again', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.scm.markDraft({ ...pr, draft: true }, false);
    await ctx.scm.markDraft({ ...pr, draft: true }, false);
    return 'completed';
  });
  try {
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'finished',
    });
    expect(spies.agent).toHaveBeenCalledTimes(1);
    expect(spies.upload).toHaveBeenCalledTimes(1);
    expect(spies.postReport).toHaveBeenCalledTimes(1);
    expect(spies.comment).toHaveBeenCalledTimes(1);
    expect(spies.revision).toHaveBeenCalledTimes(3);
  } finally {
    await f.runtime.close();
  }
});
