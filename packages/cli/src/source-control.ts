import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import {
  readCredentials,
  readInstanceConfig,
  readRepositoryProfile,
  resolveSourceControl,
  sourceControlEnv,
  type RockyPaths,
} from '@rocky/daemon';
import type { CliIo } from './cli.js';

export function attachSourceControlCommand(
  program: Command,
  io: CliIo,
  paths: RockyPaths,
): void {
  program
    .command('exec <command> [args...]')
    .description(
      'Run a command with Rocky source control credentials (e.g. gh auth login).',
    )
    .option('--profile <id>', 'Use this profile’s source control overrides.')
    .action(
      async (command: string, args: string[], flags: { profile?: string }) => {
        try {
          const config = await readInstanceConfig(paths);
          const profile = flags.profile
            ? await readRepositoryProfile(paths, flags.profile)
            : undefined;
          const repo =
            profile?.repos?.[0]?.name ??
            config.repos.find((repo) => repo.profile === profile?.id)?.name;
          const credentials = await readCredentials(paths);
          const settings = resolveSourceControl(
            {
              ...config.sourceControl,
              git: {
                name: config.identity.name,
                email: config.identity.email,
                ...config.sourceControl?.git,
              },
            },
            profile?.sourceControl,
          );
          const env = sourceControlEnv(settings, {
            ...process.env,
            ...(repo ? credentials.repos[repo] : {}),
          });
          process.exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(command, args, { env, stdio: 'inherit' });
            child.on('error', reject);
            child.on('exit', (code, signal) =>
              resolve(code ?? (signal === 'SIGINT' ? 130 : 1)),
            );
          });
        } catch (error) {
          io.err(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      },
    );
}
