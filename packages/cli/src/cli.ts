import {
  rockyPaths,
  runDaemon,
  runDoctor,
  anyFailed,
  DaemonAlreadyRunningError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type DoctorCheck,
  type DoctorOptions,
  type RockyPaths,
} from '@rocky/daemon';
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
import { createConsolePrompter } from './setup/prompter.js';
import { runSetup } from './setup/wizard.js';
import {
  daemonStatus,
  startDetached,
  stopDaemon,
  StartFailedError,
  type AddressFlags,
  type ControlOptions,
} from './daemon-control.js';
import { followLog, readTail } from './logs.js';
import {
  installService,
  uninstallService,
  UnsupportedPlatformError,
  type ServiceEnvironment,
} from './service.js';
import { CLI_VERSION } from './version.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Everything a test needs to drive the CLI without a real daemon or disk. */
export interface CliOptions extends ControlOptions {
  paths?: RockyPaths;
  /** Resolves to stop `logs -f`. Defaults to SIGINT. */
  until?: Promise<void>;
  /**
   * Kept apart from the control options above: doctor's `fetch` goes through
   * the *public* URL while the control commands' goes to loopback, and a test
   * that stubs one rarely means the other.
   */
  doctor?: DoctorOptions;
  /** Overrides where the service unit is written and what it runs. */
  service?: ServiceEnvironment;
  /** Setup seams stay on the CLI because the wizard owns terminal I/O. */
  runSetup?: typeof runSetup;
  createPrompter?: typeof createConsolePrompter;
}

/**
 * The three things a command does that a test cannot: talk to a terminal, bind
 * a socket, and watch a file. Defaulted to the real ones, so production reads
 * exactly as if they were called directly.
 */
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

/** The `--host`/`--port` pair, deliberately without commander defaults. */
type AddressOptionValues = { host?: string; port?: string };

/**
 * An unset flag stays unset, so `daemon-control` can fall back to the pidfile
 * and then to `config.json`. A commander default would erase that difference
 * and address the wrong daemon whenever the port is not 7625.
 */
function addressFlags(options: AddressOptionValues): AddressFlags {
  return {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: Number(options.port) }),
  };
}

function withAddressOptions(command: Command): Command {
  return command
    .option('--host <host>', `Bind address. Defaults to ${DEFAULT_HOST}.`)
    .option(
      '--port <port>',
      `Port for the local API and the web UI. Defaults to ${String(DEFAULT_PORT)}.`,
    );
}

/** A doctor check as one block: the verdict, what was found, what to do. */
function renderCheck(check: DoctorCheck): string[] {
  const mark = check.skipped
    ? '–'
    : check.ok
      ? '✓'
      : check.advisory
        ? '!'
        : '✗';
  const lines = [`${mark} ${check.name}`, `    ${check.detail}`];
  if (check.fix !== undefined) {
    lines.push(`    fix: ${check.fix}`);
  }
  return lines;
}

/**
 * Builds the whole `rocky` surface. Commander is configured not to call
 * `process.exit`, so the CLI is drivable from a test.
 */
export function buildCli(
  io: CliIo = CONSOLE_IO,
  cli: CliOptions = {},
): Command {
  const paths = cli.paths ?? rockyPaths();
  const setup = cli.runSetup ?? runSetup;
  const prompterFor = cli.createPrompter ?? createConsolePrompter;

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

  const fail = (message: string): void => {
    io.err(message);
    process.exitCode = 1;
  };

  withAddressOptions(
    program
      .command('start')
      .description('Run the daemon, serving the local API and the web UI.')
      .option('-d, --detach', 'Run in the background.'),
  ).action(async (options: AddressOptionValues & { detach?: boolean }) => {
    const flags = addressFlags(options);

    if (options.detach) {
      try {
        const address = await startDetached(paths, flags, cli);
        io.out(`Rocky is listening on ${address.url}`);
      } catch (error) {
        if (error instanceof StartFailedError) {
          fail(error.message);
          return;
        }
        throw error;
      }
      return;
    }

    try {
      const daemon = await runDaemon({
        paths,
        ...flags,
        // A foreground daemon shows its log in the terminal as well as
        // writing it, so `rocky start` is not a silent process.
        echo: process.stdout,
      });
      io.out(`Rocky is listening on ${daemon.url}`);
      // Held open by the server; `stopped` settles on SIGTERM, SIGINT or an
      // API shutdown, which is what lets the command return cleanly.
      await daemon.stopped;
    } catch (error) {
      if (error instanceof DaemonAlreadyRunningError) {
        fail(error.message);
        return;
      }
      throw error;
    }
  });

  withAddressOptions(
    program.command('status').description('Ask the running daemon how it is.'),
  ).action(async (options: AddressOptionValues) => {
    const status = await daemonStatus(
      paths,
      addressFlags(options),
      cli,
      io.err,
    );

    if (!status.running) {
      if (status.staleReason !== undefined) {
        io.err(status.staleReason);
      }
      fail(
        `no daemon answering at ${status.address.url} — \`rocky start\` to launch one`,
      );
      return;
    }

    io.out(
      `Rocky v${status.version ?? '?'} is running on ${status.address.url}`,
    );
    if (status.record) {
      io.out(
        `pid ${String(status.record.pid)}, up since ${status.record.startedAt}`,
      );
    }
    if (status.web === false) {
      io.out('The web UI is not built into this daemon.');
    }
    // A repo can appear through a hand-edit of `config.json` and be cloned
    // by the daemon with nobody watching, so `rocky status` is where that
    // becomes visible (NG-521).
    io.out(await repoSummary());
    if (!status.endpoint?.configured) {
      io.out('No public URL configured — run `rocky setup`.');
    } else if (status.endpoint.ok) {
      io.out('The public endpoint is reachable.');
    } else {
      io.err(
        `Warning: Linear cannot reach Rocky — the public endpoint ${status.endpoint.detail ?? 'is not answering'}. Webhooks will not arrive until it is back; Runs still progress via polling. See docs/public-endpoint.md.`,
      );
    }
  });

  withAddressOptions(
    program.command('stop').description('Stop the running daemon.'),
  ).action(async (options: AddressOptionValues) => {
    const outcome = await stopDaemon(paths, addressFlags(options), cli);

    if (outcome.stopped) {
      io.out(
        `Rocky stopped${outcome.pid === undefined ? '' : ` (pid ${String(outcome.pid)})`}.`,
      );
      return;
    }

    if (outcome.reason === 'not-running') {
      if (outcome.cleanedStalePidfile) {
        // Detected, not obeyed — and cleared, so the next start is quiet.
        io.out(
          `No daemon was running. Removed the stale ${paths.pidFile} it left behind.`,
        );
        return;
      }
      io.out('No daemon is running.');
      return;
    }

    fail(
      `pid ${String(outcome.pid)} did not stop, over the API or on SIGTERM — \`kill -9 ${String(outcome.pid)}\` is the last resort`,
    );
  });

  withAddressOptions(
    program
      .command('restart')
      .description('Stop the running daemon and start it again.'),
  ).action(async (options: AddressOptionValues) => {
    const flags = addressFlags(options);
    const outcome = await stopDaemon(paths, flags, cli);

    if (!outcome.stopped && outcome.reason === 'would-not-die') {
      fail(
        `pid ${String(outcome.pid)} did not stop, so it was not restarted — \`kill -9 ${String(outcome.pid)}\` is the last resort`,
      );
      return;
    }

    try {
      const address = await startDetached(paths, flags, cli);
      io.out(`Rocky is listening on ${address.url}`);
    } catch (error) {
      if (error instanceof StartFailedError) {
        fail(error.message);
        return;
      }
      throw error;
    }
  });

  program
    .command('logs')
    .description("Print the daemon's log.")
    .option('-f, --follow', 'Stream new lines.')
    .option('-n, --lines <count>', 'How many lines of history to print.', '200')
    .action(async (options: { follow?: boolean; lines: string }) => {
      const lines = Number(options.lines);
      for (const line of await readTail(paths, { lines })) {
        io.out(line);
      }

      if (!options.follow) {
        return;
      }

      await followLog(paths, io.out, {
        until:
          cli.until ??
          new Promise<void>((resolve) => {
            process.once('SIGINT', () => resolve());
          }),
      });
    });

  program
    .command('doctor')
    .description(
      'Endpoint self-ping, config validation and harness sign-in checks.',
    )
    .action(async () => {
      const report = await runDoctor(paths, cli.doctor ?? {});

      for (const check of report) {
        for (const line of renderCheck(check)) {
          io.out(line);
        }
      }

      if (anyFailed(report)) {
        fail('`rocky doctor` found problems. Each ✗ above names its fix.');
        return;
      }
      io.out('All checks passed.');
    });

  const service = program.command('service').description('`service` commands.');

  service
    .command('install')
    .description(
      'Write a launchd or systemd user unit so the daemon survives a reboot.',
    )
    .action(async () => {
      try {
        const { target, changed } = await installService(paths, cli.service);
        io.out(
          changed
            ? `Wrote ${target.file}`
            : `${target.file} was already up to date`,
        );
        io.out(`Load it now with: ${target.loadHint}`);
      } catch (error) {
        if (error instanceof UnsupportedPlatformError) {
          fail(error.message);
          return;
        }
        throw error;
      }
    });

  service
    .command('uninstall')
    .description('Remove the launchd or systemd user unit.')
    .action(async () => {
      try {
        const { target, removed } = await uninstallService(cli.service);
        if (!removed) {
          io.out(`No unit at ${target.file}.`);
          return;
        }
        io.out(`Removed ${target.file}`);
        io.out(`If it is still loaded, unload it with: ${target.unloadHint}`);
      } catch (error) {
        if (error instanceof UnsupportedPlatformError) {
          fail(error.message);
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

export { DaemonClient, DaemonUnreachableError };
