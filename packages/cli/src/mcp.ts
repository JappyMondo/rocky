import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loginMcpServer,
  profileMcpConfig,
  readInstanceConfig,
  readRepositoryProfile,
  type McpLoginOptions,
  type RockyPaths,
} from '@rocky/daemon';
import { Command, InvalidArgumentError } from 'commander';

import type { CliIo } from './cli.js';

export interface McpCliOptions extends Omit<
  McpLoginOptions,
  'paths' | 'openBrowser' | 'clientId' | 'clientSecret' | 'callbackPort'
> {
  /** @deprecated Repository working copies are never consulted for MCP config. */
  cwd?: string;
  openBrowser?: McpLoginOptions['openBrowser'];
}

export function attachMcpCommand(
  program: Command,
  io: CliIo,
  paths: RockyPaths,
  options: McpCliOptions = {},
): void {
  program
    .command('mcp')
    .description('MCP authentication for this machine.')
    .command('login <server>')
    .description(
      'Authenticate a remote server declared in a local repository profile.',
    )
    .requiredOption(
      '--repo <name>',
      'Repository whose local profile declares the server.',
    )
    .option(
      '--client-id <id>',
      'Use a pre-registered OAuth client instead of dynamic registration.',
    )
    .option(
      '--client-secret <secret>',
      'Secret for a pre-registered OAuth client (visible in shell history).',
    )
    .option(
      '--callback-port <port>',
      'Fixed loopback callback port for a pre-registered client; defaults to an ephemeral port.',
      (text: string) => {
        const port = Number(text);
        if (
          !/^\d+$/.test(text) ||
          !Number.isInteger(port) ||
          port < 0 ||
          port > 65535
        )
          throw new InvalidArgumentError(
            'port must be an integer from 0 to 65535.',
          );
        return port;
      },
    )
    .action(
      async (
        name: string,
        flags: {
          repo: string;
          clientId?: string;
          clientSecret?: string;
          callbackPort?: number;
        },
      ) => {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.once('SIGINT', cancel);
        try {
          const instance = await readInstanceConfig(paths);
          const repo = instance.repos.find(
            (entry) => entry.name === flags.repo,
          );
          if (!repo)
            throw new Error(
              `No local repository named "${flags.repo}". Run \`rocky repo list\`.`,
            );
          if (!repo.profile)
            throw new Error(
              `Repository "${repo.name}" is a legacy entry with no local profile. Create or explicitly import one; Rocky will not read .rocky/mcp.json from Git.`,
            );
          const profile = await readRepositoryProfile(paths, repo.profile);
          const config = profileMcpConfig(profile, paths.profile(profile.id));
          await loginMcpServer(config, name, {
            ...options,
            ...flags,
            paths,
            signal: AbortSignal.any([
              abort.signal,
              ...(options.signal ? [options.signal] : []),
            ]),
            openBrowser:
              options.openBrowser ??
              (async (url, signal) => {
                io.out(
                  `Opening the browser to authenticate MCP server ${name}...`,
                );
                const command =
                  process.platform === 'darwin'
                    ? 'open'
                    : process.platform === 'win32'
                      ? 'rundll32.exe'
                      : 'xdg-open';
                const args =
                  process.platform === 'win32'
                    ? ['url.dll,FileProtocolHandler', url.href]
                    : [url.href];
                await promisify(execFile)(command, args, {
                  timeout: 10_000,
                  signal,
                });
              }),
          });
          io.out(
            `Authenticated MCP server ${name}. Saved URL-keyed credentials in credentials.json (0600).`,
          );
        } catch (error) {
          io.err(
            error instanceof Error
              ? error.message
              : 'MCP login failed; retry rocky mcp login.',
          );
          process.exitCode = 1;
        } finally {
          process.removeListener('SIGINT', cancel);
        }
      },
    );
}
