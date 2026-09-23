import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { codex } from './codex.js';
import type { HarnessInvocation } from './types.js';

// Real CLI, local Responses API fixture. No external model or credentials.
it.runIf(process.env.ROCKY_CODEX_POLICY_TESTS === '1')(
  'enforces grants and resumes using the real Codex CLI',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'rocky-codex-cli-')),
    );
    const requests: {
      tools: { name?: string; type: string }[];
      input: unknown[];
      model: string;
      reasoning?: { effort: string };
    }[] = [];
    let action:
      | { kind: 'patch'; path: string }
      | { kind: 'bash'; cmd?: string }
      | undefined;
    let actionSent = false;
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const request = JSON.parse(
        (req.headers['content-encoding'] === 'zstd'
          ? zstdDecompressSync(bytes)
          : bytes
        ).toString(),
      );
      requests.push(request);
      const read =
        request.tools?.find(
          (tool: { name?: string }) =>
            tool.name === 'mcp__rocky_read__read_file',
        ) ??
        (JSON.stringify(request.input).includes('"name":"mcp__rocky_read"')
          ? { name: 'mcp__rocky_read__read_file' }
          : undefined);
      const hasResult = JSON.stringify(request.input).includes('cranberry');
      const search =
        requests.length < 10 &&
        request.tools?.find(
          (tool: { type: string }) => tool.type === 'tool_search',
        );
      let output: Record<string, unknown> =
        search && !read && !hasResult
          ? {
              id: 'search_fixture',
              type: 'tool_search_call',
              call_id: 'search_call',
              execution: 'client',
              arguments: { query: 'rocky_read read_file' },
              status: 'completed',
            }
          : read && !hasResult && requests.length < 5
            ? {
                id: 'fc_fixture',
                type: 'function_call',
                call_id: 'call_fixture',
                name: 'read_file',
                namespace: 'mcp__rocky_read',
                arguments: JSON.stringify({ path: 'marker.txt' }),
                status: 'completed',
              }
            : {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: hasResult ? 'cranberry' : 'fixture response',
                    annotations: [],
                  },
                ],
              };
      if (action && !actionSent) {
        actionSent = true;
        output =
          action.kind === 'patch'
            ? {
                type: 'custom_tool_call',
                id: 'patch_fixture',
                call_id: 'patch_call',
                name: 'apply_patch',
                input: `*** Begin Patch\n*** Add File: ${action.path}\n+written\n*** End Patch\n`,
                status: 'completed',
              }
            : {
                type: 'function_call',
                id: 'shell_fixture',
                call_id: 'shell_call',
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: action.cmd ?? 'printf shell-ok',
                }),
                status: 'completed',
              };
      }
      const response = {
        id: `resp_${requests.length}`,
        object: 'response',
        status: 'completed',
        output: [output],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.created',
          response: { ...response, status: 'in_progress', output: [] },
        },
        { type: 'response.output_item.added', output_index: 0, item: output },
        { type: 'response.output_item.done', output_index: 0, item: output },
        { type: 'response.completed', response },
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port');
    try {
      const home = join(root, 'home');
      const cwd = join(root, 'work');
      await mkdir(home);
      await mkdir(join(cwd, '.codex'), { recursive: true });
      await writeFile(join(cwd, 'marker.txt'), 'cranberry');
      const unsafe =
        '[features]\nshell_tool=true\n[ mcp_servers.ungranted ]\ncommand="must-not-launch"\n';
      await writeFile(join(cwd, '.codex', 'config.toml'), unsafe);
      await writeFile(join(home, 'config.toml'), unsafe);
      const command = join(root, 'codex-fixture.mjs');
      const overrides = [
        '-c',
        'model_provider="fixture"',
        '-c',
        `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses"}`,
      ];
      await writeFile(
        command,
        `#!/usr/bin/env node\nimport {spawn} from 'node:child_process';\nconst args=process.argv.slice(2);args.splice(args.indexOf('--'),0,...${JSON.stringify(overrides)});const child=spawn(${JSON.stringify(process.env.ROCKY_CODEX_COMMAND ?? 'codex')},args,{stdio:'inherit'});\nchild.on('error',()=>process.exit(1));child.on('exit',(code)=>process.exit(code??1));\n`,
      );
      await chmod(command, 0o700);
      const input: HarnessInvocation = {
        command,
        cwd,
        env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home },
        model: 'gpt-5.4',
        effort: 'high',
        prompt: 'Read marker.txt and remember the word.',
        capabilities: ['read'],
        mcpServers: [],
        sessionStorage: 'codex',
        transcriptPath: join(root, 'sessions', 'step.jsonl'),
        timeoutMs: 20_000,
      };
      const first = await codex.run(input);
      expect(first.text).toBe('cranberry');
      expect(first.events).toContainEqual({
        kind: 'tool-result',
        name: 'mcp__rocky_read__read_file',
      });
      expect(JSON.stringify(requests)).toContain('mcp__rocky_read');
      expect(requests[0].tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(['exec_command']),
      );
      expect(JSON.stringify(requests[0].tools)).not.toMatch(
        /ungranted|spawn_agent|web_search/,
      );
      expect(requests[0]).toMatchObject({
        model: 'gpt-5.4',
        reasoning: { effort: 'high' },
      });
      const before = await readFile(input.transcriptPath, 'utf8');
      const next = await codex.resume({
        ...input,
        sessionId: first.sessionId,
        prompt: 'Recall the word.',
      });
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.text).toBe('cranberry');
      expect(
        (await readFile(input.transcriptPath, 'utf8')).startsWith(before),
      ).toBe(true);
      expect(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')).toBe(
        unsafe,
      );
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(unsafe);
      action = { kind: 'patch', path: 'blocked.txt' };
      actionSent = false;
      await codex.run({
        ...input,
        capabilities: [],
        transcriptPath: join(root, 'blocked.jsonl'),
      });
      await expect(stat(join(cwd, 'blocked.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(JSON.stringify(requests.at(-1)?.input)).toMatch(
        /reject|denied|not.*allow/i,
      );

      action = { kind: 'patch', path: 'allowed.txt' };
      actionSent = false;
      const edited = await codex.run({
        ...input,
        capabilities: ['edit'],
        transcriptPath: join(root, 'edit.jsonl'),
      });
      expect(await readFile(join(cwd, 'allowed.txt'), 'utf8')).toBe(
        'written\n',
      );
      expect(edited.events).toContainEqual({
        kind: 'tool-result',
        name: 'apply_patch',
      });

      action = { kind: 'bash' };
      actionSent = false;
      const shell = await codex.run({
        ...input,
        capabilities: ['bash'],
        transcriptPath: join(root, 'bash.jsonl'),
      });
      expect(shell.events).toContainEqual({
        kind: 'tool-result',
        name: 'bash',
      });
      expect(JSON.stringify(requests.at(-1)?.input)).toContain('shell-ok');

      const source = join(root, 'source');
      const gitWorktree = join(root, 'git-worktree');
      execFileSync('git', ['init', '-b', 'main', source]);
      execFileSync(
        'git',
        ['-C', source, 'commit', '--allow-empty', '-m', 'base'],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.invalid',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.invalid',
          },
        },
      );
      execFileSync('git', [
        '-C',
        source,
        'worktree',
        'add',
        '-b',
        'issue',
        gitWorktree,
      ]);
      await writeFile(join(gitWorktree, 'change.txt'), 'new\n');
      action = {
        kind: 'bash',
        cmd: 'git add change.txt && git -c user.name=Test -c user.email=test@example.invalid commit -m change',
      };
      actionSent = false;
      await codex.run({
        ...input,
        cwd: gitWorktree,
        capabilities: ['edit', 'bash'],
        transcriptPath: join(root, 'git-blocked.jsonl'),
      });
      expect(JSON.stringify(requests.at(-1)?.input)).toMatch(
        /Permission denied|Operation not permitted/,
      );
      expect(
        execFileSync('git', ['-C', gitWorktree, 'status', '--short'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('?? change.txt');
      actionSent = false;
      await codex.run({
        ...input,
        cwd: gitWorktree,
        capabilities: ['edit', 'bash'],
        gitMetadataDirectories: [join(source, '.git')],
        transcriptPath: join(root, 'git.jsonl'),
      });
      expect(
        execFileSync('git', ['-C', gitWorktree, 'log', '-1', '--format=%s'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('change');

      const evidence = join(root, 'evidence');
      await mkdir(evidence);
      action = { kind: 'patch', path: join(evidence, 'capture.txt') };
      actionSent = false;
      await codex.run({
        ...input,
        capabilities: ['read', 'bash'],
        evidenceDirectories: [evidence],
        transcriptPath: join(root, 'evidence.jsonl'),
      });
      expect(await readFile(join(evidence, 'capture.txt'), 'utf8')).toBe(
        'written\n',
      );

      await expect(
        codex.run({
          ...input,
          capabilities: [],
          mcpServers: [
            {
              name: 'broken',
              config: { type: 'stdio', command: 'rocky-missing-mcp-command' },
            },
          ],
          transcriptPath: join(root, 'mcp-failure.jsonl'),
        }),
      ).rejects.toMatchObject({ retryable: false });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
