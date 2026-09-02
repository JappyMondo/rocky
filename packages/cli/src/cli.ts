import { startDaemon, DEFAULT_HOST, DEFAULT_PORT } from '@rocky/daemon';
import { Command } from 'commander';

import { DaemonClient, DaemonUnreachableError } from './client.js';
import {
  STUBBED_COMMANDS,
  notImplementedMessage,
  type StubbedCommand,
} from './commands.js';
import {
  addRepo,
  listRepos,
  removeRepo,
  repoSummary,
  type AddRepoOptions,
} from './repo.js';
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
          // NG-594 laid out ~/.rocky; writing daemon.pid and rotating
          // logs/daemon.log is the daemon-lifecycle ticket's job.
          io.err(
            '`rocky start -d` is not implemented yet — NG-595 owns the pidfile and log rotation. Run without `-d` for now.',
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
        // A repo can appear through a hand-edit of `config.json` and be cloned
        // by the daemon with nobody watching, so `rocky status` is where that
        // becomes visible (NG-521).
        io.out(await repoSummary());
      } catch (error) {
        if (error instanceof DaemonUnreachableError) {
          io.err(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  // NG-521 owns these three. `add` clones before it writes anything, which is
  // why it lives in the CLI rather than behind the daemon's API: the failure
  // has to reach the terminal a human is sitting at.
  const repo = program.command('repo').description('`repo` commands.');

  repo
    .command('add <url>')
    .description('Clone a repo eagerly and add it to the instance config.')
    .option(
      '--name <name>',
      'Repo name. Defaults to the last path segment of the url.',
    )
    .option(
      '--label <label>',
      'The Linear label that routes a delegation here. Defaults to the repo name.',
    )
    .option(
      '--base-branch <branch>',
      "Branch new work starts from. Defaults to the upstream's own default branch.",
    )
    .action((url: string, options: AddRepoOptions) =>
      addRepo(io, url, options),
    );

  repo
    .command('list')
    .description('List the configured repos and repo groups.')
    .action(() => listRepos(io));

  repo
    .command('remove <name>')
    .description('Remove a repo entry from the instance config.')
    .action((name: string) => removeRepo(io, name));

  for (const stub of STUBBED_COMMANDS) {
    attachStub(program, stub, io);
  }

  return program;
}
