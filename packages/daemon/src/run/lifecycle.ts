import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Workflow } from '@rocky/sdk';
import type { RockyPaths } from '../config/paths.js';
import {
  createWorkflowContext,
  type CheckpointApprovalVerifier,
  type ExternalServices,
} from './context.js';
import { readRunHeader, updateRunHeader, type RunHeader } from './header.js';
import {
  runBoot,
  type BootContext,
  type BootResult,
  type RunBootOptions,
} from './replay.js';
import { startCommand, type OwnedCommand } from './process.js';

export interface WorkflowRuntimeOptions {
  paths: RockyPaths;
  /**
   * Optional composition seam for NG-605. The composition root binds this to
   * runPreflight plus frozen members and MCP config; the runtime owns only the
   * journal ordering and replay.
   */
  startPreflight?(
    run: RunHeader,
    steps: BootContext,
    signal: AbortSignal,
  ): Promise<void>;
  /** NG-598 supplies the snapshotted Workflow, never a mutable repo import. */
  loadWorkflow(run: RunHeader, signal: AbortSignal): Promise<Workflow>;
  /** Framework preparation (workspace/Preflight), journaled through these same Steps. */
  beforeWorkflow?(
    run: RunHeader,
    steps: BootContext,
    signal: AbortSignal,
  ): Promise<void>;
  workspace?(run: RunHeader): string;
  baseRef?(run: RunHeader): string;
  env?(run: RunHeader): NodeJS.ProcessEnv;
  external?(
    run: RunHeader,
    steps: BootContext,
    signal: AbortSignal,
    approvals: CheckpointApprovalVerifier,
  ): ExternalServices;
  execTimeoutMs?: number;
  append?: RunBootOptions['append'];
  read?: RunBootOptions['read'];
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
        append: this.options.append,
        read: this.options.read,
        workflow: async (steps) => {
          run = await readRunHeader(paths, run.runId);
          if (kind === 'run') {
            await this.kill(run);
            const reserved = new Set([...this.ports.values()].flat());
            let port: number;
            do {
              const server = createServer();
              port = await new Promise<number>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                  const address = server.address();
                  if (!address || typeof address === 'string') {
                    reject(new Error('Could not reserve a Run port'));
                    return;
                  }
                  const chosen = address.port;
                  server.close((error) =>
                    error ? reject(error) : resolve(chosen),
                  );
                });
              });
            } while (reserved.has(port));
            this.ports.set(run.runId, [port]);
            run = await updateRunHeader(paths, run.runId, { ports: [port] });
          }
          await this.options.startPreflight?.(run, steps, signal);
          const workflow = await this.options.loadWorkflow(run, signal);
          await this.options.beforeWorkflow?.(run, steps, signal);
          const cwd =
            this.options.workspace?.(run) ?? paths.run(run.runId).workspaceDir;
          const exec = async (
            command: string,
            background: boolean,
            commandCwd = cwd,
          ) => {
            const child = startCommand(command, {
              cwd: commandCwd,
              background,
              signal,
              timeoutMs: this.options.execTimeoutMs,
              env: this.options.env?.(run),
            });
            const children =
              this.commands.get(run.runId) ?? new Set<OwnedCommand>();
            children.add(child);
            this.commands.set(run.runId, children);
            void child.closed.then(() => children.delete(child));
            return await child.result;
          };
          const git = async (args: string[], gitCwd = cwd) => {
            const command = ['git', ...args]
              .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
              .join(' ');
            const result = await exec(command, false, gitCwd);
            if (!('stdout' in result))
              throw new Error('Expected foreground git result');
            if (result.exitCode !== 0)
              throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
            return result.stdout;
          };
          return await workflow(
            createWorkflowContext(steps, run, {
              exec,
              changedFiles: async () => {
                const members = run.execution?.members ?? [
                  { path: '', baseBranch: '' },
                ];
                const files: string[] = [];
                for (const member of members) {
                  const memberCwd = join(cwd, member.path);
                  const baseRef = member.baseBranch
                    ? `origin/${member.baseBranch}`
                    : this.options.baseRef?.(run);
                  if (!baseRef)
                    throw new Error(
                      'Configure baseRef on the Run runtime for ctx.changedFiles',
                    );
                  const base = await git(
                    ['merge-base', baseRef, 'HEAD'],
                    memberCwd,
                  );
                  const tracked = await git(
                    ['diff', '--name-only', '-z', base.trim(), '--'],
                    memberCwd,
                  );
                  const untracked = await git(
                    ['ls-files', '--others', '--exclude-standard', '-z'],
                    memberCwd,
                  );
                  files.push(
                    ...(tracked + untracked)
                      .split('\0')
                      .filter(Boolean)
                      .map((file) =>
                        member.path ? `${member.path}/${file}` : file,
                      ),
                  );
                }
                return [...new Set(files)];
              },
              external: (branch, approvals) =>
                this.options.external?.(run, branch, signal, approvals) ?? {},
            }),
            {
              members:
                run.execution?.members.map(({ name, path, lead }) => ({
                  name,
                  path,
                  lead,
                })) ?? [],
            },
          );
        },
      });
      return result;
    } finally {
      if (
        !result ||
        result.status === 'finished' ||
        result.status === 'failed' ||
        result.status === 'cancelled'
      ) {
        await this.kill(run);
        this.ports.delete(run.runId);
      }
    }
  };

  kill = async (run: RunHeader): Promise<void> => {
    await Promise.all(
      [...(this.commands.get(run.runId) ?? [])].map((child) => child.stop()),
    );
    this.commands.delete(run.runId);
  };

  async close(): Promise<void> {
    await Promise.all(
      [...this.commands.values()].flatMap((children) =>
        [...children].map((child) => child.stop()),
      ),
    );
    this.commands.clear();
    this.ports.clear();
  }
}
