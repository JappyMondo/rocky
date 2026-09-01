import { startDaemon, DEFAULT_HOST, DEFAULT_PORT } from '@rocky/daemon';
import { Command } from 'commander';

import { DaemonClient, DaemonUnreachableError } from './client.js';
import {
  STUBBED_COMMANDS,
  notImplementedMessage,
  type StubbedCommand,
} from './commands.js';
import { CLI_VERSION } from './version.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * `repo add <url>` is a `repo` command with an `add` subcommand, but
 * `trigger <name> <issue>` is one command taking two arguments. The difference
 * is whether the second word is an argument placeholder.
 */
function attachStub(program: Command, stub: StubbedCommand, io: CliIo): void {
  const [head, second] = stub.signature.split(' ');
  const isGroup = second !== undefined && !/^[<[]/.test(second);

  const parent = isGroup
    ? (program.commands.find((c) => c.name() === head) ??
      program.command(head).description(`\`${head}\` commands.`))
    : program;

  const signature = isGroup
    ? stub.signature.slice(head.length + 1)
    : stub.signature;

  const command = parent
    .command(signature)
    .description(stub.description)
    .action(() => {
      io.err(notImplementedMessage(stub));
      process.exitCode = 1;
    });

  for (const option of stub.options ?? []) {
    command.option(option.flags, option.description);
  }
}

/**
 * Builds the whole `rocky` surface. Commander is configured not to call
 * `process.exit`, so the CLI is drivable from a test.
 */
export function buildCli(io: CliIo = CONSOLE_IO): Command {
  const program = new Command('rocky')
    .description("Rocky's per-developer local daemon and its client.")
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.out(str.replace(/\n$/, '')),
      writeErr: (str) => io.err(str.replace(/\n$/, '')),
    });

  program
    .command('start')
    .description('Run the daemon, serving the local API and the web UI.')
    .option('-d, --detach', 'Run in the background.')
    .option('--host <host>', 'Bind address.', DEFAULT_HOST)
    .option(
      '--port <port>',
      'Port for the local API and the web UI.',
      String(DEFAULT_PORT),
    )
    .action(
      async (options: { detach?: boolean; host: string; port: string }) => {
        if (options.detach) {
          // Daemonizing needs ~/.rocky for daemon.pid and the rotated log.
          io.err(
            '`rocky start -d` is not implemented yet — NG-594 owns `~/.rocky`. Run without `-d` for now.',
          );
          process.exitCode = 1;
          return;
        }

        const daemon = await startDaemon({
          host: options.host,
          port: Number(options.port),
        });
        io.out(`Rocky is listening on ${daemon.url}`);
      },
    );

  program
    .command('status')
    .description('Ask the running daemon how it is.')
    .option('--host <host>', 'Bind address.', DEFAULT_HOST)
    .option(
      '--port <port>',
      'Port the daemon listens on.',
      String(DEFAULT_PORT),
    )
    .action(async (options: { host: string; port: string }) => {
      const client = new DaemonClient({
        host: options.host,
        port: Number(options.port),
        warn: io.err,
      });

      try {
        const health = await client.health();
        io.out(`Rocky v${health.version} is running on ${client.url}`);
        if (!health.web) {
          io.out('The web UI is not built into this daemon.');
        }
      } catch (error) {
        if (error instanceof DaemonUnreachableError) {
          io.err(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  for (const stub of STUBBED_COMMANDS) {
    attachStub(program, stub, io);
  }

  return program;
}
