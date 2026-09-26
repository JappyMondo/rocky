import { recapReadabilityProblems } from './recap.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { createAgent } from '../run/agent.js';
import { runBoot } from '../run/replay.js';
import type { HarnessInvocation } from '../harness/types.js';
import { generateReport, recapId, reportMarkdown } from './reporter.js';
import { CaptureFor, RecapNarrative, generateRecapContent } from './recap.js';
import type { ConfiguredAgent, RecapAgentRole } from '@rocky/sdk';

const patch =
  'diff --git a/src/route.ts b/src/route.ts\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -1 +1 @@\n-deny();\n+allowAdmin();\n';
const categories = [
  'security',
  'permissions',
  'routes',
  'data',
  'compatibility',
  'operations',
  'testing',
  'other',
];
const narrative = {
  title: 'Admin access',
  goal: 'Let administrators use the route.',
  summary: 'Allow administrators to access the route.',
  decision: {
    status: 'needs-attention',
    summary: 'Verify administrator access.',
    actions: ['Confirm mobile access.'],
  },
  requirements: [
    {
      label: 'Administrator access',
      criterion: 'Allow administrators.',
      status: 'supported',
      evidence: ['src/route.ts:1 implements the gate.'],
    },
  ],
  behavior: [
    {
      scenario: 'An administrator opens the route',
      before: 'Access is denied.',
      after: 'Access is permitted.',
      evidence: ['Source inspection of src/route.ts:1.'],
    },
  ],
  ui: { changed: true, summary: 'Administrator route changes.' },
  problems: [
    {
      problem: 'Admins were denied.',
      solution: 'Use the admin authorization check.',
    },
  ],
  diagrams: [],
  verification: ['Inspected the route diff.'],
  limitations: [],
  keyChanges: [
    {
      title: 'Authorization',
      summary: 'Permit the admin role.',
      files: ['src/route.ts'],
      annotations: [
        { file: 'src/route.ts', line: 1, text: 'Authorization gate changes.' },
      ],
    },
  ],
  reviewFocus: categories.map((category) => ({
    category,
    title: category,
    summary: 'Inspect route authorization.',
    status: 'attention',
    evidence: ['src/route.ts:1'],
  })),
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    deliverable?: string;
    auditFails?: boolean;
    version?: 1 | 2;
    narrative?: typeof narrative;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-recap-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const p = paths.run('TEST-1-1');
  const artifacts = new LocalArtifacts(paths);
  await mkdir(p.screenshotsDir, { recursive: true });
  await writeFile(
    join(p.screenshotsDir, 'desktop.png'),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const invoke = vi.fn(async (request: HarnessInvocation) => {
    let result: unknown;
    if (request.prompt.includes('Inventory the visual evidence needed'))
      result = {
        variants: options.deliverable
          ? []
          : ['desktop', 'mobile'].map((id) => ({
              id,
              group: 'Admin screen',
              variant: id,
              description: 'Admin access',
              instructions: 'Open the admin route.',
            })),
        exclusions: [],
      };
    else if (
      request.prompt.includes('Explain the finished work for a human reviewer')
    ) {
      expect(request.prompt).toContain('"visuals"');
      if (!options.deliverable && options.version !== 1)
        expect(request.prompt).toContain('Desktop admin screen');
      result = {
        ...(options.narrative ?? narrative),
        keyChanges: options.deliverable ? [] : narrative.keyChanges,
      };
    } else if (
      request.prompt.includes('Capture the requested visual variant')
    ) {
      expect(request.prompt).toContain('agent-browser skills get core');
      expect(request.prompt).toContain('previewUrl');
      expect(request.capabilities).toEqual(['read', 'bash']);
      expect(request.env.ROCKY_BROWSER_SESSION).toMatch(/^rocky-/);
      const mobile = /"id"\s*:\s*"mobile"/.test(request.prompt);
      const captureRoot = /"screenshotDir"\s*:\s*"([^"\n]+)"/.exec(
        request.prompt,
      )?.[1];
      if (!captureRoot) throw new Error('Missing capture directory');
      await writeFile(
        join(captureRoot, 'desktop.png'),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      result = {
        group: 'Admin screen',
        variant: mobile ? 'mobile' : 'desktop',
        description: 'Admin route',
        status: mobile ? 'unavailable' : 'captured',
        reason: mobile ? 'Mobile preview cannot authenticate.' : '',
        screenshots: mobile
          ? []
          : [{ path: 'desktop.png', caption: 'Desktop admin screen' }],
      };
    } else {
      expect(request.prompt).toContain('Capture Steps own browser commands');
      expect(request.capabilities).toEqual(['read']);
      result = {
        problems: options.auditFails
          ? ['Permission change lacks evidence.']
          : [],
      };
    }
    return {
      text: `<result>${JSON.stringify({ ...(result as object), summary: 'Recap step complete.' })}</result>`,
      events: [],
      sessionId: 'recap-fixture',
    };
  });
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
          adapterFor: () => ({ run: invoke, resume: invoke }),
        });
        await generateReport({
          steps,
          agent,
          agentOptions: {},
          artifacts,
          runId: 'TEST-1-1',
          enhanced: true,
          version: options.version,
          diff: options.deliverable ? '' : patch,
          deliverable: options.deliverable,
          title: 'Admin access',
          issue: {},
          screenshotDir: p.screenshotsDir,
          workspace: [],
          port: undefined,
        });
        return 'completed';
      },
    });
  return { boot, invoke, artifacts, screenshotDir: p.screenshotsDir };
}

it('inventories variants, captures evidence, attaches actual diffs and saves an audited recap once', async () => {
  const f = await fixture();
  const first = await f.boot();
  expect(first, JSON.stringify(first)).toMatchObject({ status: 'finished' });
  expect(f.invoke).toHaveBeenCalledTimes(5);
  const [report] = await f.artifacts.listReports('TEST-1-1');
  expect(report.goal).toBe(narrative.goal);
  expect(report.requirements?.[0].label).toBe('Administrator access');
  expect(report.keyChanges?.[0].diff).toBe(patch);
  expect(report.files).toEqual([{ path: 'src/route.ts', status: 'modified' }]);
  expect(report.visuals).toHaveLength(2);
  expect(report.visuals[1].status).toBe('unavailable');
  expect(report.limitations).toContain(
    'Admin screen / mobile: Mobile preview cannot authenticate.',
  );
  expect(report.visuals[0].screenshots[0].id).toMatch(/^s_/);
  expect(reportMarkdown(report, 'https://rocky.example')).toContain(
    'Open visual recap in Rocky',
  );
  expect(reportMarkdown(report, 'https://rocky.example')).not.toContain(
    'allowAdmin();',
  );
  await f.boot();
  expect(f.invoke).toHaveBeenCalledTimes(5);
});

it('does not save a recap that still fails its independent audit after two passes', async () => {
  const f = await fixture({ auditFails: true });
  expect(await f.boot()).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('after two passes') },
  });
  expect(f.invoke).toHaveBeenCalledTimes(10);
  expect(await f.artifacts.listReports('TEST-1-1')).toEqual([]);
});

it('rejects a ready handoff when its own requirement assessment records a gap', async () => {
  const f = await fixture({
    narrative: {
      ...narrative,
      decision: {
        status: 'ready',
        summary: 'The change is ready for review.',
        actions: [],
      },
      requirements: narrative.requirements.map((requirement) => ({
        ...requirement,
        status: 'gap',
      })),
    },
  });
  expect(await f.boot()).toMatchObject({
    status: 'failed',
    error: {
      message: expect.stringContaining(
        'gap or unverified requirements cannot be marked ready',
      ),
    },
  });
  expect(await f.artifacts.listReports('TEST-1-1')).toEqual([]);
});

it('preserves the old narrative-before-capture order and report identity for legacy replay', async () => {
  const f = await fixture({ version: 1 });
  expect(await f.boot()).toMatchObject({ status: 'finished' });
  expect(f.invoke.mock.calls[1][0].prompt).toContain(
    'Explain the finished work',
  );
  expect(f.invoke.mock.calls[2][0].prompt).toContain(
    'Capture the requested visual',
  );
  await f.boot();
  expect(f.invoke).toHaveBeenCalledTimes(5);
  expect(
    recapId({
      pr: {
        repo: 'niotix',
        number: 6396,
        headSha: '75300ee4ec6264d059afded3d3aac28f71d0f68e',
      },
      enhanced: true,
      version: 1,
    }),
  ).toBe('r_078dff0733d2bd46aecbe255cb402f82');
});

it('stores comment deliverables without inventing a PR or code diff', async () => {
  const f = await fixture({ deliverable: 'The architecture explanation.' });
  expect(await f.boot()).toMatchObject({ status: 'finished' });
  const [report] = await f.artifacts.listReports('TEST-1-1');
  expect(report.pr).toBeUndefined();
  expect(report.deliverable).toBe('The architecture explanation.');
  expect(report.keyChanges).toEqual([]);
  expect(f.invoke).toHaveBeenCalledTimes(3);
  expect(recapId({ deliverable: 'one' })).not.toBe(
    recapId({ deliverable: 'two' }),
  );
});

it('rejects missing screenshot files and omitted review categories', async () => {
  const f = await fixture();
  expect(
    CaptureFor(f.screenshotDir).safeParse({
      group: 'Screen',
      variant: 'Desktop',
      description: 'View',
      status: 'captured',
      reason: '',
      screenshots: [{ path: 'missing.png', caption: 'Missing' }],
    }).success,
  ).toBe(false);
  expect(
    RecapNarrative.safeParse({
      ...narrative,
      reviewFocus: narrative.reviewFocus.slice(1),
    }).success,
  ).toBe(false);
});

it('uses configured agents for every recap subtask and resolves their input at call time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-recap-config-'));
  roots.push(root);
  const roles: RecapAgentRole[] = [
    'inventory',
    'narrative',
    'capture',
    'audit',
  ];
  const seen: Record<string, unknown> = {};
  const agents = Object.fromEntries(
    roles.map((role) => [
      role,
      (input: unknown): ConfiguredAgent => {
        seen[role] = input;
        return {
          prompt:
            role === 'audit'
              ? 'my-audit-prompt'
              : { prompt: `My ${role} prompt` },
          options: {
            harness: 'claude-code',
            model: `${role}-model`,
            effort: 'high',
            tools: [],
            mcp: ['custom-tools'],
            input: { custom: input },
            timeout: 1234,
          },
        };
      },
    ]),
  ) as Record<RecapAgentRole, (input: unknown) => ConfiguredAgent>;
  const agent = vi
    .fn()
    .mockResolvedValueOnce({
      variants: [
        {
          id: 'screen',
          group: 'App',
          variant: 'Desktop',
          description: 'The screen',
          instructions: 'Inspect the screen',
        },
      ],
      exclusions: [],
    })
    .mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'No preview credentials',
      screenshots: [],
    })
    .mockResolvedValueOnce({ ...narrative, keyChanges: [] })
    .mockResolvedValueOnce({ problems: [] });
  await runBoot({
    journalPath: join(root, 'journal.jsonl'),
    workflow: async (steps) => {
      const report = await generateRecapContent({
        steps,
        agent,
        agents,
        agentOptions: { model: 'must-not-leak', tools: ['bash'] },
        context: { screenshotDir: root, reportId: 'report' },
        diff: '',
        deliverable: 'Explanation',
      });
      expect(report.visuals).toHaveLength(1);
      return 'completed';
    },
  }).then((result) => expect(result).toMatchObject({ status: 'finished' }));
  expect(agent).toHaveBeenCalledTimes(4);
  for (const [index, role] of (
    ['inventory', 'capture', 'narrative', 'audit'] as const
  ).entries()) {
    expect(agent.mock.calls[index][0]).toEqual(
      role === 'audit' ? 'my-audit-prompt' : { prompt: `My ${role} prompt` },
    );
    expect(agent.mock.calls[index][1]).toMatchObject({
      harness: 'claude-code',
      model: `${role}-model`,
      effort: 'high',
      tools: [],
      mcp: ['custom-tools'],
      timeout: 1234,
      input: { custom: seen[role] },
    });
  }
  expect(seen.capture).toMatchObject({
    variant: { id: 'screen' },
    revision: 1,
  });
  expect(seen.audit).toMatchObject({
    content: { visuals: [{ variant: 'Desktop' }] },
  });
});

it('rejects a wall of text above a diagram even when the content audit accepts it', () => {
  expect(
    recapReadabilityProblems({
      diagrams: [
        { title: 'Recovery', description: Array(31).fill('word').join(' ') },
      ],
    }),
  ).toHaveLength(1);
  expect(
    recapReadabilityProblems({
      diagrams: [
        {
          title: 'Recovery',
          description:
            'Check earlier requests before starting another rewrite.',
        },
      ],
    }),
  ).toEqual([]);
});
