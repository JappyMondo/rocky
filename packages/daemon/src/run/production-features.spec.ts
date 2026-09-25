import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import type { AgentHarnessInvocation } from './agent.js';
import type { ScmPr, Workflow } from '@rocky/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { parseInstanceConfig } from '../config/schema.js';
import { writeCredentials } from '../config/store.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { appendEntry } from './journal.js';
import { runBoot } from './replay.js';
import { runPreflight } from '../scm/preflight.js';
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
  preflight: vi.fn(),
  scmAdapter: vi.fn(),
  probe: vi.fn(),
  openPr: vi.fn(),
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
  const adapter = (input: { repo: { id: string }; signal: AbortSignal }) => {
    spies.scmAdapter(input);
    return {
      repo: input.repo,
      signal: input.signal,
      openPr: spies.openPr,
      probe: spies.probe,
      markDraft: async () => ({ ...pr, draft: false }),
      postReviewReport: spies.postReport,
    };
  };
  return {
    ...actual,
    runPreflight: spies.preflight,
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
  spies.comment.mockResolvedValue('comment-verified');
  spies.preflight.mockResolvedValue(undefined);
  spies.openPr.mockResolvedValue(pr);
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
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  workflow: Workflow,
  tailscaleOrigin?: string,
  recapVersion?: 2,
  publicUrl?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-features-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const profile = newRepositoryProfile({
    id: 'app',
    remote: 'https://github.com/example/app.git',
  });
  profile.settings.secretEnv = ['GITHUB_TOKEN'];
  // Production reloads live model selections from the saved profile on each Boot.
  await writeRepositoryProfile(paths, profile);
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
    recapVersion,
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
  const config = parseInstanceConfig({
    server: { tailscaleOrigin },
    publicUrl,
  });
  const runtime = createProductionRuntime({
    paths,
    config: () => config,
    request,
    adapterFor: () => ({ run: spies.agent, resume: spies.agent }),
  });
  return { paths, run, runtime, request, config, records };
}

it.each([
  ['question', true],
  ['checkpoint', true],
  ['question', false],
  ['checkpoint', false],
] as const)(
  'wires production %s through parent IPC with Linear=%s and resumes its durable answer',
  async (kind, linear) => {
    const completed = vi.fn();
    const f = await fixture(async (ctx) => {
      const answer = await ctx[kind]({
        title: 'Which behavior?',
        body: 'Choose the required behavior.',
      });
      completed(answer);
      return 'completed';
    });
    if (!linear) {
      delete f.run.linear;
      await writeRunHeader(f.paths, f.run);
    }
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
          stepKey: linear ? '2' : '1',
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

it('publishes a standalone public review link to both the PR and ticket when a public origin is configured', async () => {
  const f = await fixture(
    async (ctx) => {
      await ctx.scm.markDraft({ ...pr, draft: true }, false);
      return 'completed';
    },
    undefined,
    undefined,
    'https://rocky.example.test',
  );
  try {
    expect(
      await f.runtime.boot(f.run, 'run', new AbortController().signal),
    ).toMatchObject({ status: 'finished' });
    const markdown = spies.postReport.mock.calls[0][1] as string;
    expect(markdown).toMatch(
      /https:\/\/rocky.example.test\/reviews\/[0-9a-f]{64}/,
    );
    expect(markdown).not.toContain('localhost');
    expect(markdown).not.toContain('/runs/');
    expect(spies.comment).toHaveBeenCalledWith(expect.any(String), markdown);
    const token = /\/reviews\/([0-9a-f]{64})/.exec(markdown)![1];
    const saved = JSON.parse(
      await readFile(
        join(f.paths.root, 'shared-reviews', token, 'report.json'),
        'utf8',
      ),
    );
    expect(saved.report.title).toBe(content.title);
    await f.runtime.boot(f.run, 'run', new AbortController().signal);
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
  'fails visibly for missing or invalid %s before the first SCM action',
  async (failure) => {
    const f = await fixture(async (ctx) => {
      await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
      return 'completed';
    });
    if (failure === 'profile') f.run.profile = undefined;
    else if (failure === 'token') {
      if (!f.run.profile) throw new Error('Missing fixture profile');
      f.run.profile.sourceControl = {
        github: { tokenEnv: 'MISSING_PROFILE_TOKEN' },
      };
      await writeRepositoryProfile(f.paths, f.run.profile);
      await writeCredentials(f.paths, {
        linear: { accessToken: 'fixture' },
        repos: {},
      });
    } else {
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

it('completes a comment-only Workflow without constructing SCM adapters or probing SCM authority', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.comment('The requested analysis and evidence.');
    return 'completed';
  });
  try {
    await expect(
      f.runtime.boot(f.run, 'run', new AbortController().signal),
    ).resolves.toMatchObject({ status: 'finished', outcome: 'completed' });
    expect(spies.preflight).toHaveBeenCalledTimes(1);
    expect(spies.preflight.mock.calls[0][1]).toMatchObject({
      scope: 'mcp',
      members: [],
    });
    expect(spies.scmAdapter).not.toHaveBeenCalled();
    expect(spies.comment).toHaveBeenCalledWith(
      expect.any(String),
      'The requested analysis and evidence.',
    );
  } finally {
    await f.runtime.close();
  }
});

it('checks SCM authority once before the first PR effect and fails closed', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.comment('Scope is clear.');
    await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
    return 'completed';
  });
  spies.preflight.mockImplementation(async (_steps, options) => {
    if (options.scope === 'scm') {
      expect(spies.comment).toHaveBeenCalled();
      expect(spies.openPr).not.toHaveBeenCalled();
      throw new Error('Merge authority is unknown.');
    }
  });
  try {
    await expect(
      f.runtime.boot(f.run, 'run', new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { message: 'Merge authority is unknown.' },
    });
    expect(spies.preflight.mock.calls.map((call) => call[1].scope)).toEqual([
      'mcp',
      'scm',
    ]);
    expect(spies.openPr).not.toHaveBeenCalled();
  } finally {
    await f.runtime.close();
  }
});

it('shares the SCM preflight across repeated operations in one Workflow', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
    await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
    return 'completed';
  });
  spies.openPr.mockResolvedValue({ ...pr, draft: true });
  try {
    await expect(
      f.runtime.boot(f.run, 'run', new AbortController().signal),
    ).resolves.toMatchObject({ status: 'finished' });
    expect(spies.preflight.mock.calls.map((call) => call[1].scope)).toEqual([
      'mcp',
      'scm',
    ]);
    expect(spies.openPr).toHaveBeenCalledTimes(2);
  } finally {
    await f.runtime.close();
  }
});

it('resumes a legacy parked Run without moving its recorded startup preflight', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.question({ title: 'Scope?', body: 'Clarify scope.' });
    await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
    return 'completed';
  });
  const legacyProbe = vi.fn();
  try {
    const parked = await runBoot({
      journalPath: f.paths.run(f.run.runId).journal,
      workflow: async (steps) => {
        for (const key of ['workspace', 'linear.start', 'preflight'])
          await steps.step(key, {}, async () => ({
            status: 'done',
            result: null,
          }));
        await steps.step('question', {}, async () => ({ status: 'waiting' }));
        return 'completed';
      },
    });
    expect(parked).toMatchObject({ status: 'parked' });
    spies.preflight.mockImplementation(async (steps, options) =>
      steps.step(
        options.scope ? `preflight.${options.scope}` : 'preflight',
        {},
        async () => {
          legacyProbe();
          return { status: 'done', result: null };
        },
      ),
    );
    spies.checkpoint.mockResolvedValue({
      status: 'done',
      result: { decision: 'steer', message: 'Proceed.' },
    });
    spies.openPr.mockResolvedValue({ ...pr, draft: true });
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(spies.preflight).toHaveBeenCalledTimes(1);
    expect(spies.preflight.mock.calls[0][1].scope).toBeUndefined();
    expect(legacyProbe).not.toHaveBeenCalled();
    expect(spies.openPr).toHaveBeenCalledTimes(1);
  } finally {
    await f.runtime.close();
  }
});

it('opens a PR-only deliverable with denied merge authority using the real deferred preflight', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
    return 'completed';
  });
  const allowed = { status: 'allowed', source: 'fixture', fix: '' };
  spies.probe.mockResolvedValue({
    repo: 'app',
    platform: 'github',
    merge: {
      status: 'denied',
      source: 'fixture',
      fix: 'Ask a maintainer to merge.',
    },
    rebase: allowed,
    sourcePush: allowed,
    draft: allowed,
  });
  spies.preflight.mockImplementation(async (steps, options) => {
    if (options.scope === 'scm') return runPreflight(steps, options);
    return undefined;
  });
  spies.openPr.mockResolvedValue({ ...pr, draft: true });
  try {
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(spies.probe).toHaveBeenCalledTimes(1);
    expect(spies.openPr).toHaveBeenCalledTimes(1);
  } finally {
    await f.runtime.close();
  }
});

it('rejects a visual recap without a subject before capturing or publishing evidence', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.visualRecap({ title: 'Empty' });
    return 'completed';
  });
  try {
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: 'ctx.visualRecap requires a PR, diff, or deliverable' },
    });
    expect(spies.agent).not.toHaveBeenCalled();
    expect(spies.comment).not.toHaveBeenCalled();
    expect(spies.scmAdapter).not.toHaveBeenCalled();
  } finally {
    await f.runtime.close();
  }
});

function enhancedRecapAgent() {
  spies.agent.mockImplementation(async (input: AgentHarnessInvocation) => {
    const response = input.prompt.includes('Inventory the visual evidence')
      ? { variants: [], exclusions: ['No UI changes in this subject.'] }
      : input.prompt.includes('Independently audit this recap')
        ? { problems: [] }
        : {
            ...content,
            decision: {
              status: 'needs-attention',
              summary: 'Review the evidence.',
              actions: ['Confirm delivery.'],
            },
            requirements: [
              {
                criterion: 'Explain the outcome.',
                status: 'supported',
                evidence: ['Supplied subject.'],
              },
            ],
            behavior: [
              {
                scenario: 'Review the outcome',
                before: 'Unexplained.',
                after: 'Explained.',
                evidence: ['Supplied subject.'],
              },
            ],
            ui: { changed: false, summary: 'Internal classification.' },
            keyChanges: [],
            reviewFocus: [
              'security',
              'permissions',
              'routes',
              'data',
              'compatibility',
              'operations',
              'testing',
              'other',
            ].map((category) => ({
              category,
              title: category,
              summary: 'No applicable changes.',
              status: 'not-applicable',
              evidence: ['Inspected supplied subject.'],
            })),
          };
    return {
      text: `<result>${JSON.stringify({ ...response, summary: 'Recap evidence collected.' })}</result>`,
      events: [],
      sessionId: 'recap-session',
    };
  });
}

it('passes workflow evidence through the production v2 recap and retains its decision fields', async () => {
  enhancedRecapAgent();
  const f = await fixture(
    async (ctx) => {
      await ctx.visualRecap({ deliverable: 'Explain the outcome.' });
      return 'completed';
    },
    undefined,
    2,
  );
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
    expect(report.decision?.status).toBe('needs-attention');
    expect(report.requirements?.[0].criterion).toBe('Explain the outcome.');
    expect(spies.agent.mock.calls[1][0].prompt).toContain('"workflowEvidence"');
    expect(spies.agent.mock.calls[1][0].prompt).toContain('"repositories"');
  } finally {
    await f.runtime.close();
  }
});

it('hosts a deliverable recap without SCM and publishes its Tailscale link once across replay', async () => {
  enhancedRecapAgent();
  let recap: { id: string; url: string } | undefined;
  const f = await fixture(async (ctx) => {
    recap = await ctx.visualRecap({
      deliverable: 'Analysis with verified evidence.',
      title: 'Investigation recap',
    });
    return 'completed';
  }, 'https://rocky.tail123.ts.net:7625');
  try {
    await writeCredentials(f.paths, {
      linear: { accessToken: 'fixture' },
      repos: {},
    });
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'finished',
    });
    expect(recap?.url).toBe(
      `https://rocky.tail123.ts.net:7625/runs/${f.run.runId}?report=${recap?.id}`,
    );
    const [report] = await new LocalArtifacts(f.paths).listReports(f.run.runId);
    expect(report.id).toBe(recap?.id);
    expect(report.pr).toBeUndefined();
    expect(spies.comment).toHaveBeenCalledWith(
      `report:${report.id}`,
      expect.stringContaining(recap?.url ?? 'missing recap URL'),
    );
    expect(spies.scmAdapter).not.toHaveBeenCalled();
    expect(spies.revision).not.toHaveBeenCalled();
    expect(spies.upload).not.toHaveBeenCalled();
    const calls = spies.agent.mock.calls.length;
    await f.runtime.boot(f.run, 'run', new AbortController().signal);
    expect(spies.agent).toHaveBeenCalledTimes(calls);
    expect(spies.comment).toHaveBeenCalledTimes(1);
  } finally {
    await f.runtime.close();
  }
});

it.each([undefined, 'https://rocky.example.test'])(
  'reuses an explicit PR recap when marking ready (public origin: %s)',
  async (publicUrl) => {
    enhancedRecapAgent();
    const f = await fixture(
      async (ctx) => {
        const recap = await ctx.visualRecap({ pr });
        await ctx.scm.markDraft({ ...pr, draft: true }, false, {
          body: recap.url,
        });
        return 'completed';
      },
      undefined,
      undefined,
      publicUrl,
    );
    try {
      const result = await f.runtime.boot(
        f.run,
        'run',
        new AbortController().signal,
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'finished',
      });
      expect(
        await new LocalArtifacts(f.paths).listReports(f.run.runId),
      ).toHaveLength(1);
      expect(spies.postReport).toHaveBeenCalledTimes(1);
      expect(spies.comment).toHaveBeenCalledTimes(1);
      expect(spies.upload).not.toHaveBeenCalled();
      const calls = spies.agent.mock.calls.length;
      if (!publicUrl) {
        // Simulate an already published run from before URLs were persisted.
        for (const key of f.records.keys())
          if (key.endsWith(':url')) f.records.delete(key);
        f.config.publicUrl = 'https://rocky.example.test';
      }
      expect(
        await f.runtime.boot(f.run, 'run', new AbortController().signal),
      ).toMatchObject({ status: 'finished' });
      expect(spies.agent).toHaveBeenCalledTimes(calls);
      expect(spies.postReport).toHaveBeenCalledTimes(1);
      if (publicUrl) {
        const markdown = spies.postReport.mock.calls[0][1] as string;
        const token = /\/reviews\/([0-9a-f]{64})/.exec(markdown)![1];
        const saved = JSON.parse(
          await readFile(
            join(f.paths.root, 'shared-reviews', token, 'report.json'),
            'utf8',
          ),
        );
        const [report] = await new LocalArtifacts(f.paths).listReports(
          f.run.runId,
        );
        expect(saved.report.id).toBe(report.id);
        expect(saved.report.keyChanges).toBeDefined();
      }
    } finally {
      await f.runtime.close();
    }
  },
);

it('refuses to publish a recap if the pushed PR revision changes during capture', async () => {
  enhancedRecapAgent();
  const f = await fixture(async (ctx) => {
    await ctx.visualRecap({ pr });
    return 'completed';
  });
  spies.revision
    .mockResolvedValueOnce({
      headSha: pr.headSha,
      baseSha: 'b'.repeat(40),
      diff: '+clarify',
    })
    .mockRejectedValueOnce(new Error('PR head changed during capture'));
  try {
    const result = await f.runtime.boot(
      f.run,
      'run',
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: 'PR head changed during capture' },
    });
    expect(spies.postReport).not.toHaveBeenCalled();
    expect(spies.comment).not.toHaveBeenCalled();
  } finally {
    await f.runtime.close();
  }
});

it('creates a complete enhanced recap even when a legacy report exists for the same PR head', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.scm.markDraft({ ...pr, draft: true }, false);
    enhancedRecapAgent();
    await ctx.visualRecap({ pr });
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
    const reports = await new LocalArtifacts(f.paths).listReports(f.run.runId);
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((report) => report.id)).size).toBe(2);
    expect(
      reports.filter((report) => report.keyChanges !== undefined),
    ).toHaveLength(1);
    expect(spies.postReport).toHaveBeenCalledTimes(2);
    expect(spies.comment).toHaveBeenCalledTimes(2);
    const calls = spies.agent.mock.calls.length;
    await f.runtime.boot(f.run, 'run', new AbortController().signal);
    expect(spies.agent).toHaveBeenCalledTimes(calls);
    expect(spies.postReport).toHaveBeenCalledTimes(2);
  } finally {
    await f.runtime.close();
  }
});

it.each(['github', 'gitlab'] as const)(
  'uses the selected %s profile token for built-in SCM operations',
  async (platform) => {
    const f = await fixture(async (ctx) => {
      await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
      return 'completed';
    });
    if (!f.run.profile || !f.run.execution)
      throw new Error('Missing fixture profile');
    f.run.profile.sourceControl = {
      [platform]: { tokenEnv: 'PROFILE_SCM_TOKEN' },
    };
    f.run.execution.members[0].url = `https://${platform}.com/example/app.git`;
    await writeRepositoryProfile(f.paths, f.run.profile);
    await writeCredentials(f.paths, {
      linear: { accessToken: 'fixture' },
      repos: {
        app: {
          PROFILE_SCM_TOKEN: 'profile-only-token',
          GITHUB_TOKEN: 'legacy-token',
          GITLAB_TOKEN: 'legacy-token',
        },
      },
    });
    await writeRunHeader(f.paths, f.run);
    try {
      expect(
        await f.runtime.boot(f.run, 'run', new AbortController().signal),
      ).toMatchObject({ status: 'finished' });
      expect(spies.scmAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'profile-only-token' }),
      );
    } finally {
      await f.runtime.close();
    }
  },
);

it('uses ambient GitHub credentials for built-in SCM when no source is selected', async () => {
  const f = await fixture(async (ctx) => {
    await ctx.scm.openPr({ title: 'Change', body: '', draft: true });
    return 'completed';
  });
  if (!f.run.profile) throw new Error('Missing fixture profile');
  f.run.profile.settings.secretEnv = [];
  await writeRepositoryProfile(f.paths, f.run.profile);
  await writeRunHeader(f.paths, f.run);
  await writeCredentials(f.paths, {
    linear: { accessToken: 'fixture' },
    repos: { app: {} },
  });
  vi.stubEnv('GH_TOKEN', 'ambient-gh-token');
  vi.stubEnv('GITHUB_TOKEN', '');
  try {
    expect(
      await f.runtime.boot(f.run, 'run', new AbortController().signal),
    ).toMatchObject({ status: 'finished' });
    expect(spies.scmAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'ambient-gh-token' }),
    );
  } finally {
    await f.runtime.close();
  }
});
