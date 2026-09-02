/**
 * The command table is the deliverable here — NG-515 scaffolds it and the
 * tickets named in `commands.ts` fill it in. So these assert that the whole
 * v1 surface parses, and that a stub is honest about being one.
 */
import { startDaemon, type RunningDaemon } from '@rocky/daemon';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rockyPaths } from '@rocky/daemon';

import { buildCli, type CliIo } from './cli.js';
import { STUBBED_COMMANDS, notImplementedMessage } from './commands.js';
import type { createConsolePrompter } from './setup/prompter.js';

/** Every command a developer can type, flattened out of the nesting. */
const V1_SURFACE = [
  'setup',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'doctor',
  'service install',
  'service uninstall',
  'repo add',
  'repo list',
  'repo remove',
  'init',
  'upgrade',
  'mcp login',
  'trigger',
];

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    lines: { out, err },
    io: {
      out: (line: string) => {
        out.push(line);
      },
      err: (line: string) => {
        err.push(line);
      },
    } satisfies CliIo,
  };
}

/** Names of every leaf command, as `parent child` where nested. */
function surfaceOf(): string[] {
  const program = buildCli(io().io);
  return program.commands.flatMap((command) =>
    command.commands.length > 0
      ? command.commands.map((child) => `${command.name()} ${child.name()}`)
      : [command.name()],
  );
}

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe('the command table', () => {
  it('is the complete v1 surface', () => {
    expect(surfaceOf().sort()).toEqual([...V1_SURFACE].sort());
  });

  it('nests `repo`, `service` and `mcp` rather than flattening them', () => {
    const surface = surfaceOf();

    expect(surface).toContain('repo add');
    expect(surface).toContain('service install');
    expect(surface).toContain('mcp login');
  });

  it('has no stub left for the `repo` commands, which NG-521 implemented', () => {
    expect(STUBBED_COMMANDS.map((command) => command.signature)).not.toContain(
      expect.stringContaining('repo'),
    );
    expect(STUBBED_COMMANDS.some((command) => command.owner === 'NG-521')).toBe(
      false,
    );
  });

  it('takes the manual Trigger as one command with two arguments', () => {
    const program = buildCli(io().io);
    const trigger = program.commands.find((c) => c.name() === 'trigger');

    expect(trigger?.registeredArguments.map((a) => a.name())).toEqual([
      'name',
      'issue',
    ]);
  });
});

describe('a stubbed command', () => {
  it.each(STUBBED_COMMANDS.map((c) => [c.signature, c] as const))(
    '`%s` says which ticket owns it and fails',
    async (_signature, stub) => {
      const { lines, io: cliIo } = io();
      const argv = stub.signature
        .split(' ')
        .filter((token) => !/^[<[]/.test(token));
      // Fill any required argument with a placeholder so parsing succeeds.
      const args = stub.signature
        .split(' ')
        .filter((token) => token.startsWith('<'))
        .map((_, index) => `arg${index}`);

      await buildCli(cliIo).parseAsync(['node', 'rocky', ...argv, ...args]);

      expect(lines.err).toEqual([notImplementedMessage(stub)]);
      expect(process.exitCode).toBe(1);
    },
  );

  it('names the ticket in the message', () => {
    const init = STUBBED_COMMANDS.find((c) => c.signature === 'init');
    if (!init) throw new Error('`init` left the command table');

    expect(notImplementedMessage(init)).toBe(
      '`rocky init` is not implemented yet — NG-581 owns it. NG-515 scaffolds the command table only.',
    );
  });
});

describe('`rocky setup`', () => {
  /** A wizard stand-in, so the command's own behaviour is what is asserted. */
  function withSetup(
    result: Promise<{
      ok: boolean;
      publicUrl: string;
      endpoint: { configured: boolean; ok: boolean };
    }>,
  ) {
    const close = vi.fn();
    const { lines, io: cliIo } = io();
    const cli = buildCli(cliIo, {
      runSetup: () => result,
      createPrompter: () =>
        ({
          say: () => undefined,
          ask: async () => '',
          askSecret: async () => '',
          waitFor: async () => undefined,
          close,
        }) as unknown as ReturnType<typeof createConsolePrompter>,
    });

    return { cli, lines, close };
  }

  it('succeeds quietly when the wizard finished and the endpoint verified', async () => {
    const { cli, lines, close } = withSetup(
      Promise.resolve({
        ok: true,
        publicUrl: 'https://rocky.example.com',
        endpoint: { configured: true, ok: true },
      }),
    );

    await cli.parseAsync(['node', 'rocky', 'setup']);

    expect(process.exitCode).not.toBe(1);
    expect(lines.err).toEqual([]);
    expect(close).toHaveBeenCalled();
  });

  it('exits non-zero when the endpoint did not verify', async () => {
    const { cli } = withSetup(
      Promise.resolve({
        ok: false,
        publicUrl: 'https://rocky.example.com',
        endpoint: { configured: true, ok: false },
      }),
    );

    await cli.parseAsync(['node', 'rocky', 'setup']);

    expect(process.exitCode).toBe(1);
  });

  it('reports what went wrong and still closes the prompt', async () => {
    const { cli, lines, close } = withSetup(
      Promise.reject(new Error('Linear refused the token request: bad secret')),
    );

    await cli.parseAsync(['node', 'rocky', 'setup']);

    expect(lines.err).toEqual(['Linear refused the token request: bad secret']);
    expect(process.exitCode).toBe(1);
    // A readline left open holds stdin and the process never exits.
    expect(close).toHaveBeenCalled();
  });
});
describe('`rocky status`', () => {
  it('points at `rocky start` when no daemon answers', async () => {
    const { lines, io: cliIo } = io();
    // A temp root, so the developer's own ~/.rocky cannot decide the result.
    const root = mkdtempSync(join(tmpdir(), 'rocky-cli-'));

    await buildCli(cliIo, { paths: rockyPaths(root) }).parseAsync([
      'node',
      'rocky',
      'status',
      '--port',
      '7',
    ]);

    rmSync(root, { recursive: true, force: true });

    expect(lines.err).toEqual([
      'no daemon answering at http://127.0.0.1:7 — `rocky start` to launch one',
    ]);
    expect(process.exitCode).toBe(1);
  });

  /**
   * AC4's third surface. The daemon is a real one, so what `status` prints is
   * what the health route actually said rather than a hand-built fixture.
   */
  describe('against a running daemon', () => {
    let daemon: RunningDaemon | undefined;

    afterEach(async () => {
      await daemon?.close();
      daemon = undefined;
    });

    async function statusAgainst(
      publicUrl: () => string | undefined,
      check = true,
    ) {
      daemon = await startDaemon({
        port: 0,
        webRoot: false,
        publicUrl,
        selfPing: false,
      });
      if (check) {
        await daemon.endpoint.check();
      }

      const { lines, io: cliIo } = io();
      await buildCli(cliIo).parseAsync([
        'node',
        'rocky',
        'status',
        '--port',
        String(daemon.port),
      ]);
      return lines;
    }

    it('warns when the endpoint is dead, and says Runs keep going', async () => {
      const lines = await statusAgainst(() => 'http://127.0.0.1:1');

      expect(lines.err.join('\n')).toMatch(/Linear cannot reach Rocky/);
      expect(lines.err.join('\n')).toMatch(/Runs still progress via polling/);
      expect(lines.err.join('\n')).toMatch(/docs\/public-endpoint\.md/);
    });

    it('says so plainly when the endpoint is reachable', async () => {
      // The URL is only knowable once a port is bound, so it is read through a
      // box the test fills in — which is also how a real tunnel behaves.
      const endpoint: { url: string | undefined } = { url: undefined };
      daemon = await startDaemon({
        port: 0,
        webRoot: false,
        publicUrl: () => endpoint.url,
        selfPing: false,
      });
      endpoint.url = daemon.url;
      await daemon.endpoint.check();

      const { lines, io: cliIo } = io();
      await buildCli(cliIo).parseAsync([
        'node',
        'rocky',
        'status',
        '--port',
        String(daemon.port),
      ]);

      expect(lines.out.join('\n')).toContain(
        'The public endpoint is reachable.',
      );
      expect(lines.err).toEqual([]);
    });

    it('points at `rocky setup` on a machine with no public URL', async () => {
      const lines = await statusAgainst(() => undefined);

      expect(lines.out.join('\n')).toContain(
        'No public URL configured — run `rocky setup`.',
      );
      expect(lines.err).toEqual([]);
    });
  });
});
