/**
 * The command table is the deliverable here — NG-515 scaffolds it and the
 * tickets named in `commands.ts` fill it in. So these assert that the whole
 * v1 surface parses, and that a stub is honest about being one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCli, type CliIo } from './cli.js';
import { STUBBED_COMMANDS, notImplementedMessage } from './commands.js';

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

describe('`rocky start`', () => {
  it('refuses to daemonize until the pidfile has an owner', async () => {
    const { lines, io: cliIo } = io();

    await buildCli(cliIo).parseAsync(['node', 'rocky', 'start', '-d']);

    expect(lines.err).toEqual([
      '`rocky start -d` is not implemented yet — NG-595 owns the pidfile and log rotation. Run without `-d` for now.',
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe('`rocky status`', () => {
  it('points at `rocky start` when no daemon answers', async () => {
    const { lines, io: cliIo } = io();

    await buildCli(cliIo).parseAsync([
      'node',
      'rocky',
      'status',
      '--port',
      '7',
    ]);

    expect(lines.err).toEqual([
      'no daemon answering at http://127.0.0.1:7 — `rocky start` to launch one',
    ]);
    expect(process.exitCode).toBe(1);
  });
});
