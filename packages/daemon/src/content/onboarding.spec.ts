import { createJiti } from 'jiti';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { z } from '@rocky/sdk';
import type { TeamState } from './seed.js';

const { createOnboarding } = await createJiti(import.meta.url, {
  alias: {
    '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
      .pathname,
  },
}).import<{
  createOnboarding(options: {
    repo: string;
    shippedDir: string;
    teamStates(): Promise<TeamState[]>;
    validate(directory: string): Promise<void>;
  }): (ctx: unknown) => Promise<string>;
}>(new URL('../../content/onboarding.ts', import.meta.url).pathname);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-onboarding-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(failing = false) {
  const events: string[] = [];
  const harnesses: string[] = [];
  const posts: string[] = [];
  const pr = {
    repo: 'repo',
    id: '1',
    number: 1,
    url: 'https://example.test/seed/1',
    headSha: 'abc',
    sourceBranch: 'issue',
    baseBranch: 'main',
    state: 'open',
    draft: false,
  };
  const ctx = {
    issue: {
      identifier: 'TEST-1',
      title: 'A feature',
      description: 'Implement it.',
      url: 'https://example.test/issue/1',
      labels: [],
    },
    stage: (name: string) => {
      events.push(name);
    },
    step: async (_label: string, fn: () => unknown) => fn(),
    exec: async (command: string) => {
      events.push(command);
      return {
        exitCode: 0,
        stdout: command.includes('rev-parse') ? 'abc' : '',
        stderr: '',
      };
    },
    agent: async (
      name: string | { prompt: string },
      opts: { label?: string; schema?: z.ZodType; harness?: string },
    ) => {
      events.push(typeof name === 'string' ? name : (opts.label ?? 'inline'));
      if (opts.harness) harnesses.push(opts.harness);
      const value =
        typeof name === 'string'
          ? { action: 'retry' }
          : opts.label === 'inspect repository'
            ? {
                commands: {
                  install: 'pnpm install',
                  test: 'pnpm test',
                  lint: '',
                  build: '',
                },
                ui: null,
              }
            : { conventions: 'Use the documented public seams.' };
      return Object.assign(opts.schema?.parse(value) ?? value, {
        summary: 'Fixture summary.',
      });
    },
    post: async (body: string) => {
      posts.push(body);
    },
    scm: {
      openPr: async (options: { draft?: boolean }) => {
        expect(options.draft).toBe(false);
        events.push('openPr');
        return pr;
      },
      updateBranch: async () => ({ status: 'clean', pr }),
      waitForCi: async () => {
        events.push('waitForCi');
        return {
          status: failing ? 'failed' : 'passed',
          headSha: 'abc',
          failedJobs: failing
            ? [
                {
                  id: '1',
                  name: 'test',
                  failedSteps: [],
                  logTail: 'Existing timeout',
                },
              ]
            : [],
        };
      },
      retryFailedJobs: async () => {
        events.push('retry');
      },
      markDraft: async () => {
        throw new Error('A seed PR stays non-draft.');
      },
      armAutoMerge: async () => {
        throw new Error('Never auto-merge a seed.');
      },
    },
    linear: {
      setState: async () => {
        throw new Error('Onboarding leaves issue state untouched.');
      },
    },
  };
  const run = createOnboarding({
    repo: dir,
    shippedDir: new URL('../../content/.rocky/', import.meta.url).pathname,
    teamStates: async () => [
      { name: 'Building', type: 'started', position: 1 },
      { name: 'Reviewing', type: 'started', position: 2 },
      { name: 'Shipped', type: 'completed', position: 3 },
    ],
    validate: async (directory) => {
      expect(await readFile(join(directory, 'workflow.ts'), 'utf8')).toContain(
        'linear.onDelegate(main)',
      );
    },
  });
  return { run: () => run(ctx), events, harnesses, posts };
}

it('seeds a non-draft PR, returns completed rather than merged, and adopts the same content on re-delegation', async () => {
  const f = fixture();
  expect(await f.run()).toBe('completed');
  expect(
    f.events.some((event) =>
      event.startsWith(`cd -- '${dir}' && git add -- .rocky`),
    ),
  ).toBe(true);
  const source = await readFile(join(dir, '.rocky/workflow.ts'), 'utf8');
  expect(source).toContain('Building');
  expect(source).toContain('Reviewing');
  expect(f.posts.at(-1)).toContain('Merge it, then re-delegate.');
  expect(f.posts.at(-1)).toContain('https://example.test/seed/1');
  await writeFile(join(dir, 'unrelated.txt'), 'human work');
  expect(await f.run()).toBe('completed');
  expect(
    f.events.filter((event) => event === 'inspect repository'),
  ).toHaveLength(1);
  expect(f.harnesses).toEqual(['opencode']);
  expect(await readFile(join(dir, '.rocky/workflow.ts'), 'utf8')).toBe(source);
  expect(await readFile(join(dir, 'unrelated.txt'), 'utf8')).toBe('human work');
});

it('leaves an exhausted seed PR open and names CI failures without touching issue state', async () => {
  const f = fixture(true);
  expect(await f.run()).toBe('exhausted');
  expect(f.events.filter((event) => event === 'ci-fixer')).toHaveLength(3);
  expect(f.posts.at(-1)).toContain('Existing timeout');
  expect(f.posts.at(-1)).toContain('https://example.test/seed/1');
});
