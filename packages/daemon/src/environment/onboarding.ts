import { profileEnv } from '../config/execution-env.js';
import { readCredentials } from '../config/store.js';
import { sourceControlEnv } from '../config/source-control.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowContext, WorkflowInput } from '@rocky/sdk';
import type { EnvironmentJob } from '@rocky/local-contracts';
import type { RockyPaths } from '../config/paths.js';
import { canonicalRemote, type RepositoryProfile } from '../config/profiles.js';
import { SECRET_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import { startCommand, type OwnedCommand } from '../run/process.js';
import { WorkspaceExecution } from '../flow/workspace-execution.js';
import { ensureEnvironment } from './ensure.js';

/** Baseline verification uses disposable clones, never a checkout used by a Run.
 * Saved profile recipes are executable authority; proposals remain read-only.
 */
export class EnvironmentOnboarding {
  private active = new Map<
    string,
    { job: EnvironmentJob; done: Promise<void>; controller: AbortController }
  >();
  constructor(private paths: RockyPaths) {}
  private file(profile: string) {
    return join(
      this.paths.root,
      'cache',
      'environment',
      createHash('sha256').update(profile).digest('hex'),
      'job.json',
    );
  }
  async read(profile: string): Promise<EnvironmentJob | null> {
    const active = this.active.get(profile);
    if (active) return structuredClone(active.job);
    const encoded = await readFile(this.file(profile), 'utf8').catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      },
    );
    if (!encoded) return null;
    const job: EnvironmentJob = JSON.parse(encoded);
    if (!['ready', 'blocked'].includes(job.status)) {
      job.status = 'blocked';
      job.result = {
        status: 'blocked',
        blocker: {
          kind: 'environment',
          code: 'verification',
          capability: 'baseline',
          action:
            'Verification was interrupted. Verify the saved profile again in a fresh isolated workspace.',
        },
      };
      await writeAtomic(this.file(profile), serializeJson(job), SECRET_MODE);
    }
    return job;
  }
  async start(profile: RepositoryProfile): Promise<EnvironmentJob> {
    profile = structuredClone(profile);
    const existing = this.active.get(profile.id);
    if (existing) return structuredClone(existing.job);
    const job: EnvironmentJob = {
      id: randomUUID(),
      status: 'discovering',
      startedAt: new Date().toISOString(),
      evidence: [],
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(600_000),
    ]);
    const entry = { job, controller, done: Promise.resolve() };
    this.active.set(profile.id, entry);
    const save = () =>
      writeAtomic(this.file(profile.id), serializeJson(job), SECRET_MODE);
    const root = join(this.paths.root, 'cache', 'environment', job.id);
    const children = new Set<OwnedCommand>();
    const initialSave = save();
    entry.done = (async () => {
      await initialSave;
      let execution: WorkspaceExecution | undefined;
      try {
        const repos = profile.repos ?? [];
        if (
          !profile.configurationVersion ||
          !repos.length ||
          !repos.some((r) =>
            r.environment?.capabilities.some((c) => c.baseline),
          )
        )
          throw Error(
            'Configure baseline capability recipes before verification.',
          );
        const environment = sourceControlEnv(profile.sourceControl, {
          ...process.env,
          ...profileEnv(
            { profile, repo: repos[0].name },
            await readCredentials(this.paths),
          ),
        });
        await mkdir(join(root, 'workspace'), { recursive: true, mode: 0o700 });
        for (const repo of repos) {
          signal.throwIfAborted();
          const source = this.paths.repo(repo.name);
          const git = (args: string[], cwd = source) =>
            promisify(execFile)('git', args, {
              cwd,
              timeout: 120_000,
              signal,
            });
          const remote = await git(['remote', 'get-url', 'origin']);
          if (
            canonicalRemote(remote.stdout.trim()) !== canonicalRemote(repo.url)
          )
            throw Error('Repository remote changed.');
          const destination = join(root, 'workspace', repo.name);
          // --no-local avoids hardlinks and never runs hooks from repository configuration.
          await git(
            [
              '-c',
              'core.hooksPath=/dev/null',
              'clone',
              '--no-local',
              '--no-checkout',
              source,
              destination,
            ],
            root,
          );
          let commit: string | undefined;
          for (const ref of [
            `refs/remotes/origin/${repo.baseBranch}`,
            `refs/heads/${repo.baseBranch}`,
          ]) {
            try {
              commit = (
                await git(['rev-parse', '--verify', `${ref}^{commit}`])
              ).stdout.trim();
              break;
            } catch {
              /* Try the other supported store layout. */
            }
          }
          if (!commit) throw Error('Base branch unavailable.');
          await git(
            ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', commit],
            destination,
          );
        }
        const exec: WorkflowContext['exec'] = (async (
          command: string,
          options?: { background?: boolean; timeoutMs?: number },
        ) => {
          signal.throwIfAborted();
          const child = startCommand(command, {
            cwd: root,
            background: options?.background ?? false,
            timeoutMs: options?.timeoutMs,
            signal,
            env: environment,
          });
          children.add(child);
          try {
            const result = await child.result;
            // Setup output may contain secrets; retain only its exit code.
            return 'exitCode' in result
              ? { exitCode: result.exitCode, stdout: '', stderr: '' }
              : result;
          } finally {
            if (!options?.background) {
              await child.stop();
              children.delete(child);
            }
          }
        }) as WorkflowContext['exec'];
        const ctx = {
          exec,
          ports: [],
          replaying: false,
          stage: (label: string) => {
            job.status = label.split(': ')[1] as EnvironmentJob['status'];
          },
          step: async <T>(
            label: string,
            work: () => T | Promise<T>,
          ): Promise<T> => {
            const result = await work();
            job.evidence.push({ label, result });
            await save();
            return result;
          },
        };
        execution = new WorkspaceExecution(
          ctx,
          {
            members: repos.map((r, i) => ({
              name: r.name,
              path: r.name,
              lead: i === 0,
            })),
          } as WorkflowInput,
          repos,
          root,
          true,
          signal,
        );
        job.result = await ensureEnvironment(ctx, execution, {
          label: 'Onboarding baseline',
          allowSetup: profile.automation?.workspaceSetup === true,
        });
        job.status = job.result.status;
      } catch {
        job.status = 'blocked';
        job.result = {
          status: 'blocked',
          blocker: {
            kind: 'environment',
            code: 'configuration',
            capability: 'baseline',
            action:
              'Could not verify the saved profile. Check baseline recipes, local repository remotes/base branches and setup authorization, then verify again.',
          },
        };
      } finally {
        const cleanup = await Promise.allSettled([
          execution?.stop('Onboarding baseline'),
          ...[...children].map((child) => child.stop()),
        ]);
        // Delete only this job's disposable clones, never profile data or Run worktrees.
        try {
          await rm(root, { recursive: true, force: true });
        } catch {
          cleanup.push({
            status: 'rejected',
            reason: 'workspace cleanup failed',
          });
        }
        if (cleanup.some((result) => result.status === 'rejected')) {
          job.status = 'blocked';
          job.result = {
            status: 'blocked',
            blocker: {
              kind: 'environment',
              code: 'configuration',
              capability: 'cleanup',
              action:
                'Could not finish run-scoped environment cleanup. Check local process/filesystem permissions before verifying again.',
            },
          };
        }
        await save();
      }
    })().finally(() => this.active.delete(profile.id));
    void entry.done.catch(() => undefined);
    await initialSave;
    return structuredClone(job);
  }
  async close() {
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map((e) => e.done));
  }
}
