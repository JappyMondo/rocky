import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  loginMcpServer,
  readMcpConfig,
  type McpLoginOptions,
  type RockyPaths,
} from '@rocky/daemon';
import { Command, InvalidArgumentError } from 'commander';

import type { CliIo } from './cli.js';

export interface McpCliOptions extends Omit<
  McpLoginOptions,
  'paths' | 'openBrowser' | 'clientId' | 'clientSecret' | 'callbackPort'
> {
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
      "Authenticate a remote server declared in this repo's .rocky/mcp.json.",
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
          clientId?: string;
          clientSecret?: string;
          callbackPort?: number;
        },
      ) => {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.once('SIGINT', cancel);
        try {
          const config = await readMcpConfig(
            join(options.cwd ?? process.cwd(), '.rocky/mcp.json'),
          );
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
