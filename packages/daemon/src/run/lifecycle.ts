import { createServer } from 'node:net';

import type { BackgroundExecResult, Workflow } from '@rocky/sdk';

import type { RockyPaths } from '../config/paths.js';
import { createWorkflowContext, type ExternalContext } from './context.js';
import { readRunHeader, updateRunHeader, type RunHeader } from './header.js';
import { runBoot, type BootContext, type BootResult } from './replay.js';
import { startCommand, type OwnedCommand } from './process.js';

export interface WorkflowRuntimeOptions {
  paths: RockyPaths;
  loadWorkflow(run: RunHeader): Promise<Workflow>;
  workspace?(run: RunHeader): string;
  baseRef?(run: RunHeader): string;
  env?(run: RunHeader): NodeJS.ProcessEnv;
  external?(run: RunHeader, steps: BootContext, signal: AbortSignal): Partial<ExternalContext>;
  execTimeoutMs?: number;
}

/** One per daemon. The scheduler owns admission/cancellation; this owns exec children. */
export class WorkflowRuntime {
  private readonly commands = new Map<string, Set<OwnedCommand>>();
  private readonly ports = new Map<string, number[]>();

  constructor(private readonly options: WorkflowRuntimeOptions) {}

  boot = async (
    run: RunHeader,
    kind: 'run' | 'poll',
    signal: AbortSignal,
  ): Promise<BootResult> => {
    const paths = this.options.paths;
    let result: BootResult | undefined;
    try {
      result = await runBoot({
        journalPath: paths.run(run.runId).journal,
        poll: kind === 'poll',
        signal,
        workflow: async (steps) => {
          run = await readRunHeader(paths, run.runId);
          if (kind === 'run') {
            await this.kill(run);
            run = await updateRunHeader(paths, run.runId, { processGroups: [] });
            const port = await this.reservePort();
            this.ports.set(run.runId, [port]);
            run = await updateRunHeader(paths, run.runId, { ports: [port] });
          }
          const workflow = await this.options.loadWorkflow(run);
          const cwd = this.options.workspace?.(run) ?? paths.run(run.runId).workspaceDir;
          const exec = async (command: string, background: boolean) => {
            const child = startCommand(command, {
              cwd,
              background,
              signal,
              timeoutMs: this.options.execTimeoutMs,
              env: this.options.env?.(run),
            });
            const children = this.commands.get(run.runId) ?? new Set<OwnedCommand>();
            children.add(child);
            this.commands.set(run.runId, children);
            void child.closed.then(() => children.delete(child));
            const commandResult = await child.result;
            if (background && 'pid' in commandResult) {
              run = await updateRunHeader(paths, run.runId, {
                processGroups: [...new Set([...run.processGroups, commandResult.pid])],
              });
            }
            return commandResult;
          };
          const git = async (args: string[]) => {
            const command = ['git', ...args]
              .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
              .join(' ');
            const commandResult = await exec(command, false);
            if (!('stdout' in commandResult)) throw new Error('Expected foreground git result');
            if (commandResult.exitCode !== 0)
              throw new Error(`git ${args[0]} failed: ${commandResult.stderr.trim()}`);
            return commandResult.stdout;
          };
          return workflow(
            createWorkflowContext(steps, run, {
              exec,
              changedFiles: async () => {
                const baseRef = this.options.baseRef?.(run);
                if (!baseRef)
                  throw new Error('Configure baseRef on the Run runtime for ctx.changedFiles');
                const base = await git(['merge-base', baseRef, 'HEAD']);
                const tracked = await git(['diff', '--name-only', '-z', base.trim(), '--']);
                const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
                return [...new Set((tracked + untracked).split('\0').filter(Boolean))];
              },
              external: (branch) => this.options.external?.(run, branch, signal) ?? {},
            }),
          );
        },
      });
      return result;
    } finally {
      if (!result || ['finished', 'failed', 'cancelled'].includes(result.status)) {
        await this.kill(run);
        await this.killPersistedProcessGroups(run);
        this.ports.delete(run.runId);
      }
    }
  };

  private async reservePort(): Promise<number> {
    const reserved = new Set([...this.ports.values()].flat());
    let port: number;
    do {
      const server = createServer();
      port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('Could not reserve a Run port'));
          server.close((error) => (error ? reject(error) : resolve(address.port)));
        });
      });
    } while (reserved.has(port));
    return port;
  }

  kill = async (run: RunHeader): Promise<void> => {
    await Promise.all([...this.commands.get(run.runId) ?? []].map((child) => child.stop()));
    this.commands.delete(run.runId);
  };

  private async killPersistedProcessGroups(run: RunHeader): Promise<void> {
    const failed: number[] = [];
    await Promise.all(run.processGroups.map(async (pid) => {
      try {
        process.kill(-pid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 25));
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed.push(pid);
      }
    }));
    await updateRunHeader(this.options.paths, run.runId, { processGroups: failed });
  }

  async close(): Promise<void> {
    await Promise.all([...this.commands.values()].flatMap((children) => [...children].map((child) => child.stop())));
    this.commands.clear();
    this.ports.clear();
  }
}
