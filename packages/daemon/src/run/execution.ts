import { rm } from 'node:fs/promises';
import { createWorkspace, releaseCleanWorkspace } from '../repos/workspace.js';
import type { Issue } from '@rocky/sdk';
import type { RockyPaths } from '../config/paths.js';
import {
  readRepositoryProfile,
  canonicalRemote,
  type RepositoryProfile,
} from '../config/profiles.js';
import { route } from '../config/routing.js';
import type { InstanceConfig } from '../config/schema.js';
import type { RepoContext, RepoRef } from '../repos/index.js';
import type { RunExecution, RunHeader, RunLinearIdentity } from './header.js';
import {
  RunScheduler,
  type RunDelegation,
  type SchedulerBoot,
} from './scheduler.js';
import { JournalWriter } from './writer.js';
import type { RunWorkersOptions } from './worker.js';

export interface ExecutionRequest {
  requestId: string;
  issue: Issue;
  branch: string;
  team?: string;
  /** Local manual selection; delegations still use configured Linear routing. */
  profileId?: string;
  /** Delegations have a Linear session; locally-fired manual Runs do not. */
  linear?: RunLinearIdentity;
}

export interface PreparedExecution {
  sourceCommit: string;
  snapshotDir: string;
  trigger: RunExecution['trigger'];
  profile?: RepositoryProfile;
  members?: RepoRef[];
  lead?: RepoRef;
  dispose?(): Promise<void>;
}

/** Parent-owned bridge to Linear control; Boot children only use its IPC requests. */
export interface AgentSteerControl {
  open(
    runId: string,
    conversation: { stepKey: string; label: string; group?: string },
  ): Promise<void>;
  take(
    runId: string,
    stepKey: string,
  ): Promise<{ ids: string[]; message: string } | undefined>;
  delivered(
    runId: string,
    stepKey: string,
    ids: readonly string[],
  ): Promise<void>;
  close(runId: string, stepKey: string): Promise<void>;
}

export interface ExecutionOptions {
  paths: RockyPaths;
  config(): InstanceConfig;
  repos: RepoContext;
  /** Linear control publishes into the already-acknowledged owned session. */
  onRefusal(request: ExecutionRequest, message: string): Promise<void>;
  /** Shipped content supplies its internal snapshot and binding, never a product fallback. */
  onboarding?(lead: RepoRef, signal: AbortSignal): Promise<PreparedExecution>;
  preserve?(run: RunHeader): Promise<void>;
  onError?(error: unknown): void;
  onAgentEvent?(runId: string, stepKey: string, event: unknown): void;
  agentSteer?: AgentSteerControl;
  runtime?: {
    boot: SchedulerBoot;
    kill(run: RunHeader): Promise<void>;
    close(): Promise<void>;
  };
  prepareSnapshot?(
    lead: RepoRef,
    trigger: RunExecution['trigger'],
    signal: AbortSignal,
  ): Promise<PreparedExecution>;
}

export type ExecutionAdmission =
  RunDelegation | { kind: 'refused'; message: string };

type ExecutionRequestHandler = NonNullable<RunWorkersOptions['onRequest']>;

/** Parent-side request handler used by an owned Boot process. */
export function createExecutionRequestHandler(
  options: Pick<ExecutionOptions, 'paths' | 'repos' | 'agentSteer'>,
  getRun: (runId: string) => Promise<RunHeader | undefined>,
  writer: (path: string) => Promise<JournalWriter>,
): ExecutionRequestHandler {
  return async (runId, request, signal) => {
    signal.throwIfAborted();
    const run = await getRun(runId);
    if (!run) throw new Error(`Unknown Run ${runId}`);
    const journal = await writer(options.paths.run(runId).journal);
    switch (request.kind) {
      case 'append':
        return journal.append(request.entry, request.options);
      case 'control-get':
        return journal.get(request.key);
      case 'control-put':
        return journal.put(request.key, request.value);
      case 'agent-steer-open': {
        if (!options.agentSteer)
          throw new Error(
            'Configure ExecutionOptions.agentSteer before running an Agent Step with Steer support',
          );
        return options.agentSteer.open(runId, {
          stepKey: request.stepKey,
          label: request.label,
          ...(request.group === undefined ? {} : { group: request.group }),
        });
      }
      case 'agent-steer-take': {
        if (!options.agentSteer)
          throw new Error(
            'Configure ExecutionOptions.agentSteer before running an Agent Step with Steer support',
          );
        return options.agentSteer.take(runId, request.stepKey);
      }
      case 'agent-steer-delivered': {
        if (!options.agentSteer)
          throw new Error(
            'Configure ExecutionOptions.agentSteer before running an Agent Step with Steer support',
          );
        return options.agentSteer.delivered(
          runId,
          request.stepKey,
          request.ids,
        );
      }
      case 'agent-steer-close': {
        if (!options.agentSteer)
          throw new Error(
            'Configure ExecutionOptions.agentSteer before running an Agent Step with Steer support',
          );
        return options.agentSteer.close(runId, request.stepKey);
      }
      case 'workspace': {
        if (!run.execution)
          throw new Error(
            `${runId}: missing frozen repo membership; re-delegate through production admission`,
          );
        const workspace = await createWorkspace(options.repos, {
          runId,
          branch: run.branch,
          lead: run.repo,
          members: run.execution.members,
        });
        signal.throwIfAborted();
        return workspace;
      }
    }
  };
}

/** Shared by verified delegation and local manual controls; it owns no Linear client. */
export async function openExecution(options: ExecutionOptions) {
  const writers = new Map<string, Promise<JournalWriter>>();
  const writer = (path: string) => {
    let current = writers.get(path);
    if (!current) {
      current = JournalWriter.open(path);
      writers.set(path, current);
    }
    return current;
  };
  const onRequest = createExecutionRequestHandler(
    options,
    (runId) => scheduler.get(runId),
    writer,
  );
  const runtime =
    options.runtime ??
    new (await import('./worker.js')).RunWorkers({
      paths: options.paths,
      config: options.config,
      onEvent: options.onAgentEvent,
      onError: options.onError,
      onRequest,
    });
  const scheduler = await RunScheduler.open({
    paths: options.paths,
    maxRuns: options.config().concurrency.maxRuns,
    boot: runtime.boot,
    cancellation: options.preserve
      ? { kill: runtime.kill, cleanup: options.preserve }
      : undefined,
    onError: options.onError,
    releaseTerminalWorkspace: async (run) => {
      await releaseCleanWorkspace(options.repos, run.runId);
    },
    append: async (path, entry, appendOptions) =>
      (await writer(path)).append(entry, appendOptions),
  });
  const prepareProfile = async (
    profile: RepositoryProfile,
    fallbackLead: RepoRef | undefined,
    trigger: RunExecution['trigger'],
    signal: AbortSignal,
  ): Promise<PreparedExecution> => {
    const lead = profile.repos?.[0] ?? fallbackLead;
    if (!lead)
      throw new Error(
        `Profile ${profile.id} needs repository details. Add its repositories in Profiles before starting a Run.`,
      );
    const loader = await import('./snapshot.js');
    const snapshot = await loader.prepareProfileSnapshot(
      options.repos,
      lead,
      profile,
      { signal },
    );
    try {
      return {
        ...snapshot,
        profile,
        lead,
        ...(profile.repos ? { members: profile.repos } : {}),
        trigger: loader.resolveSnapshotTrigger(snapshot.triggers, trigger),
        dispose: () =>
          rm(snapshot.snapshotDir, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(snapshot.snapshotDir, { recursive: true, force: true });
      throw error;
    }
  };
  const prepareSnapshot =
    options.prepareSnapshot ??
    (async (lead, trigger, signal) => {
      signal.throwIfAborted();
      const config = options.config();
      const configured = config.repos.find((repo) => repo.name === lead.name);
      if (!configured?.profile) {
        throw new Error(
          `${lead.name} has no local profile. Create or import one with \`rocky repo profile import\`; committed .rocky files are not used.`,
        );
      }
      const profile = await readRepositoryProfile(
        options.paths,
        configured.profile,
      );
      return prepareProfile(profile, lead, trigger, signal);
    });

  const admit = async (
    request: ExecutionRequest,
    trigger: RunExecution['trigger'],
  ): Promise<ExecutionAdmission> => {
    let prepared: PreparedExecution | undefined;
    try {
      const admitted = await scheduler.admit({
        issueIdentifier: request.issue.identifier,
        requestId: request.requestId,
        manual: trigger.kind === 'manual',
        prepare: async (_runId, signal) => {
          const config = options.config();
          const explicitProfile =
            trigger.kind === 'manual' && request.profileId
              ? await readRepositoryProfile(options.paths, request.profileId)
              : undefined;
          const destination = route(config, {
            labels: request.issue.labels,
            team: request.team,
          });
          if (!explicitProfile && destination.kind === 'refusal')
            throw new Error(destination.message);
          let lead = explicitProfile
            ? (explicitProfile.repos?.[0] ??
              config.repos.find(
                (repo) =>
                  repo.profile === explicitProfile.id &&
                  canonicalRemote(repo.url) === explicitProfile.remote,
              ))
            : destination.kind === 'repo'
              ? destination.repo
              : destination.kind === 'group'
                ? destination.lead
                : undefined;
          if (!lead)
            throw new Error(
              `Profile ${explicitProfile?.id} needs repository details. Add its repositories in Profiles before starting a Run.`,
            );
          let members: readonly RepoRef[] =
            destination.kind === 'group' && !explicitProfile
              ? destination.members
              : [lead];
          let source: RunExecution['source'] = 'repository';
          try {
            prepared = explicitProfile
              ? await prepareProfile(explicitProfile, lead, trigger, signal)
              : await prepareSnapshot(lead, trigger, signal);
          } catch (error) {
            if (!(
              error &&
              typeof error === 'object' &&
              'kind' in error &&
              error.kind === 'onboarding-required'
            ))
              throw error;
            if (!options.onboarding)
              throw new Error(
                `${String(error)} Wire the built-in Onboarding Workflow (NG-607), or run rocky init and merge the resulting .rocky/ before re-delegating.`,
              );
            await options.onRefusal(request, String(error));
            prepared = await options.onboarding(lead, signal);
            source = 'onboarding';
          }
          signal.throwIfAborted();
          lead = prepared.lead ?? lead;
          members = prepared.members ?? members;
          return {
            repo: lead.name,
            issue: request.issue,
            branch: request.branch,
            trigger: trigger.kind === 'manual' ? trigger.name : trigger.kind,
            snapshotDir: prepared.snapshotDir,
            ...(prepared.profile === undefined
              ? {}
              : { profile: prepared.profile }),
            ...(request.linear === undefined ? {} : { linear: request.linear }),
            execution: {
              source,
              sourceCommit: prepared.sourceCommit,
              trigger: prepared.trigger,
              members: members.map((member) => ({
                name: member.name,
                path: member.name,
                lead: member.name === lead.name,
                url: member.url,
                baseBranch: member.baseBranch,
              })),
            },
          };
        },
      });
      await scheduler.drain();
      return admitted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.onRefusal(request, message);
      return { kind: 'refused', message };
    } finally {
      await prepared?.dispose?.();
    }
  };

  return {
    scheduler,
    async journal(runId: string) {
      if (!(await scheduler.get(runId)))
        throw new Error(`Unknown Run ${runId}`);
      return writer(options.paths.run(runId).journal);
    },
    delegate: (request: ExecutionRequest) =>
      admit(structuredClone(request), { kind: 'linear.onDelegate' }),
    manual: (name: string, request: ExecutionRequest) =>
      admit(structuredClone(request), { kind: 'manual', name }),
    async tick() {
      await scheduler.setMaxRuns(options.config().concurrency.maxRuns);
      await scheduler.tick();
    },
    async close() {
      await scheduler.close();
      await runtime.close();
    },
  };
}

export type ExecutionIntegration = Awaited<ReturnType<typeof openExecution>>;
