import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { opencode } from './opencode.js';
import { claudeCode } from './claude-code.js';
import { runProcess } from './process.js';
import type { HarnessInvocation } from './types.js';

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
      expect(await readdir(join(root, 'sessions'))).toContain('opencode.db');
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
