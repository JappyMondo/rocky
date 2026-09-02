import {
  openConfigStore,
  rockyPaths,
  startDaemon,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from '@rocky/daemon';
import { Command } from 'commander';

import { DaemonClient, DaemonUnreachableError } from './client.js';
import {
  STUBBED_COMMANDS,
  notImplementedMessage,
  type StubbedCommand,
} from './commands.js';
import { createConsolePrompter } from './setup/prompter.js';
import { runSetup } from './setup/wizard.js';
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
 * The three things a command does that a test cannot: talk to a terminal, bind
 * a socket, and watch a file. Defaulted to the real ones, so production reads
 * exactly as if they were called directly.
 */
export interface CliDeps {
  runSetup?: typeof runSetup;
  createPrompter?: typeof createConsolePrompter;
  startDaemon?: typeof startDaemon;
  openConfigStore?: typeof openConfigStore;
}

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
export function buildCli(io: CliIo = CONSOLE_IO, deps: CliDeps = {}): Command {
  const setup = deps.runSetup ?? runSetup;
  const prompterFor = deps.createPrompter ?? createConsolePrompter;
  const start = deps.startDaemon ?? startDaemon;
  const openConfig = deps.openConfigStore ?? openConfigStore;

  const program = new Command('rocky')
    .description("Rocky's per-developer local daemon and its client.")
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.out(str.replace(/\n$/, '')),
      writeErr: (str) => io.err(str.replace(/\n$/, '')),
    });

  program
    .command('setup')
    .description(
      'Interactive first-run wizard: public URL, the Linear OAuth app, credentials.',
    )
    .action(async () => {
      const prompter = prompterFor();
      try {
        const result = await setup({ prompter });
        // A tunnel that is not up yet is a real failure to report, but the
        // credentials are written either way — see the wizard.
        if (!result.ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        prompter.close();
      }
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

        // The live view of `~/.rocky`, so the endpoint and the webhook secret
        // follow a hot config reload rather than being frozen at boot (NG-578).
        const store = await openConfig(rockyPaths(), { warn: io.err });

        const daemon = await start({
          host: options.host,
          port: Number(options.port),
          publicUrl: () => store.current.publicUrl,
          webhookSecret: async () =>
            (await store.readCredentials()).linear?.webhookSecret,
          logger: true,
        });

        io.out(`Rocky is listening on ${daemon.url}`);
        if (!store.current.publicUrl) {
          io.out(
            'No public URL configured, so Linear cannot deliver webhooks — run `rocky setup`.',
          );
        }
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

        const endpoint = health.endpoint;
        if (!endpoint || !endpoint.configured) {
          io.out('No public URL configured — run `rocky setup`.');
        } else if (endpoint.ok) {
          io.out('The public endpoint is reachable.');
        } else {
          // A warning, not a failure: Runs keep working, more slowly, and
          // nothing here offers to restart a tunnel Rocky does not manage.
          io.err(
            `Warning: Linear cannot reach Rocky — the public endpoint ${endpoint.detail ?? 'is not answering'}. Webhooks will not arrive until it is back; Runs still progress via polling. See docs/public-endpoint.md.`,
          );
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
