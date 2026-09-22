import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent, type AgentHarnessEvent } from '../run/agent.js';
import { openJournal } from '../run/journal.js';
import { runBoot } from '../run/replay.js';
import { getHarnessAdapter } from './adapter.js';
import { opencode } from './opencode.js';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { runProcess } from './process.js';
import type { HarnessInvocation } from './types.js';

const exec = promisify(execFile);

it.runIf(process.env.ROCKY_REAL_CODEX_TESTS === '1')(
  'completes a throwaway coding ticket through the real Codex Agent runner',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-live-codex-ticket-'));
    const cwd = join(root, 'workspace');
    const journalPath = join(root, 'journal.jsonl');
    try {
      await mkdir(cwd);
      await exec('git', ['init', '-b', 'codex-smoke'], { cwd });
      await writeFile(
        join(cwd, 'math.mjs'),
        'export function add(a, b) { return a - b; }\n',
      );
      const testSource = [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { add } from './math.mjs';",
        "test('adds positive, negative and zero values', () => {",
        '  assert.equal(add(2, 3), 5);',
        '  assert.equal(add(-4, -7), -11);',
        '  assert.equal(add(0, 9), 9);',
        '});',
        '',
      ].join('\n');
      await writeFile(join(cwd, 'math.test.mjs'), testSource);
      await expect(
        exec(process.execPath, ['--test', 'math.test.mjs'], { cwd }),
      ).rejects.toMatchObject({ code: 1 });
      const events: AgentHarnessEvent[] = [];
      const results: unknown[] = [];
      const workflow: Parameters<typeof runBoot>[0]['workflow'] = async (
        steps,
      ) => {
        const agent = createAgent(steps, {
          cwd,
          snapshotDir: join(cwd, '.rocky'),
          sessionDir: join(root, 'sessions'),
          harness: 'codex',
          harnesses: {
            codex: {
              command: 'codex',
              env: { ...process.env },
              sessionStorage: 'codex',
            },
          },
          adapterFor: getHarnessAdapter,
          onEvent: (_identity, event) => events.push(event),
        });
        results.push(
          await agent(
            {
              prompt:
                'Throwaway ticket TEST-CODEX: add(a, b) in math.mjs subtracts instead of adding. Fix only math.mjs, then run node --test math.test.mjs. Leave the test unchanged. This tiny fixture has no dependencies to install. Do not commit, contact external services or change other files.',
            },
            {
              label: 'TEST-CODEX',
              tools: ['read', 'edit', 'bash'],
              model: process.env.ROCKY_CODEX_MODEL,
              effort: process.env.ROCKY_CODEX_EFFORT,
              schema: z.object({ testsPassed: z.literal(true) }),
              timeout: 120_000,
            },
          ),
        );
        return 'completed';
      };
      expect(await runBoot({ journalPath, workflow })).toMatchObject({
        status: 'finished',
      });
      expect(results).toEqual([
        { testsPassed: true, summary: expect.any(String) },
      ]);
      expect(await readFile(join(cwd, 'math.test.mjs'), 'utf8')).toBe(
        testSource,
      );
      await exec(process.execPath, ['--test', 'math.test.mjs'], { cwd });
      expect(events).toContainEqual({ kind: 'tool-result', name: 'bash' });
      const entry = (await openJournal(journalPath)).latest(0);
      expect(entry).toMatchObject({
        status: 'done',
        result: { testsPassed: true, summary: expect.any(String) },
        sessionId: expect.any(String),
        progress: { usage: { inputTokens: expect.any(Number) } },
      });
      const eventCount = events.length;
      expect(await runBoot({ journalPath, workflow })).toMatchObject({
        status: 'finished',
      });
      expect(results).toHaveLength(1);
      expect((await openJournal(journalPath)).latest(0)).toEqual(entry);
      expect(events).toHaveLength(eventCount);
    } finally {
      if (process.env.ROCKY_KEEP_PROBE === '1')
        console.info('Live Codex ticket evidence:', root);
      else await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);

it.runIf(process.env.ROCKY_REAL_CODEX_TESTS === '1')(
  'continues a real Codex conversation using native session storage',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-live-codex-'));
    try {
      await writeFile(join(root, 'marker.txt'), 'cranberry');
      const input: HarnessInvocation = {
        cwd: root,
        command: 'codex',
        env: { ...process.env },
        sessionStorage: 'codex',
        transcriptPath: join(root, 'sessions', 'step.jsonl'),
        capabilities: ['read'],
        mcpServers: [],
        model: process.env.ROCKY_CODEX_MODEL,
        effort: process.env.ROCKY_CODEX_EFFORT,
        prompt:
          'Read marker.txt with the rocky_read MCP tools, remember its word and reply with exactly that word.',
        timeoutMs: 90_000,
      };
      const first = await codex.run(input);
      expect(first.text.toLowerCase()).toContain('cranberry');
      expect(first.events).toContainEqual({
        kind: 'tool-result',
        name: 'mcp__rocky_read__read_file',
      });
      const next = await codex.resume({
        ...input,
        sessionId: first.sessionId,
        prompt:
          'Recall the word I asked you to remember, without reading it again.',
      });
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.text.toLowerCase()).toContain('cranberry');
    } finally {
      if (process.env.ROCKY_KEEP_PROBE === '1')
        console.info('Live Codex evidence:', root);
      else await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);

it.runIf(process.env.ROCKY_REAL_OPENCODE_TESTS === '1')(
  'continues a real OpenCode conversation in Run-owned storage',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-live-opencode-'));
    try {
      await writeFile(join(root, 'marker.txt'), 'cranberry');
      const input: HarnessInvocation = {
        cwd: root,
        command: 'opencode',
        env: { ...process.env },
        sessionStorage: 'rocky',
        transcriptPath: join(root, 'sessions', 'step-1.jsonl'),
        capabilities: ['read'],
        mcpServers: [],
        model: process.env.ROCKY_OPENCODE_MODEL,
        prompt: `Use the read tool to read ${join(root, 'marker.txt')}. Remember its word and reply with exactly that word.`,
        timeoutMs: 90_000,
      };
      const first = await opencode.run(input);
      expect(first.text.toLowerCase()).toContain('cranberry');
      const before = await readFile(input.transcriptPath, 'utf8');
      expect(first.events).toContainEqual({
        kind: 'tool-result',
        name: 'read',
      });
      expect(first.events).toContainEqual({ kind: 'turn-boundary' });
      const next = await opencode.resume({
        ...input,
        sessionId: first.sessionId,
        prompt:
          'What word did I ask you to remember? Reply with only that word.',
      });
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.text.toLowerCase()).toContain('cranberry');
      expect(
        (await readFile(input.transcriptPath, 'utf8')).startsWith(before),
      ).toBe(true);
      expect(await readdir(join(root, 'sessions'))).toContain(
        'step-1.jsonl.opencode.db',
      );
    } finally {
      if (process.env.ROCKY_KEEP_PROBE === '1')
        console.info('Live OpenCode evidence:', root);
      else await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);

it.runIf(process.env.ROCKY_CLAUDE_AUTH_PROBE === '1')(
  'reports scoped Claude login availability without requesting a model or printing secrets',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-claude-auth-'));
    try {
      const output = await runProcess({
        command: 'claude',
        args: ['auth', 'status', '--json'],
        env: { ...process.env, CLAUDE_CONFIG_DIR: root },
        timeoutMs: 15_000,
      });
      const result = JSON.parse(output.stdout);
      console.info('Claude isolated auth:', {
        code: output.code,
        loggedIn: result.loggedIn,
        authMethod: result.authMethod,
      });
      expect(typeof result.loggedIn).toBe('boolean');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.env.ROCKY_REAL_CLAUDE_TESTS === '1')(
  'continues a real Claude conversation in a single appended Transcript',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-live-claude-'));
    try {
      const input: HarnessInvocation = {
        cwd: root,
        command: 'claude',
        env: { ...process.env },
        sessionStorage: 'rocky',
        transcriptPath: join(root, 'sessions', 'step-1.jsonl'),
        capabilities: [],
        mcpServers: [],
        prompt: 'Remember the word cranberry. Reply with exactly cranberry.',
        timeoutMs: 90_000,
      };
      const first = await claudeCode.run(input);
      const before = await readFile(input.transcriptPath, 'utf8');
      const next = await claudeCode.resume({
        ...input,
        sessionId: first.sessionId,
        prompt:
          'What word did I ask you to remember? Reply with only that word.',
      });
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.text.toLowerCase()).toContain('cranberry');
      expect(
        (await readFile(input.transcriptPath, 'utf8')).startsWith(before),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
