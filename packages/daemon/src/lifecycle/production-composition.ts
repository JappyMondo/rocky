/**
 * The production composition root.  This is deliberately the only place that
 * knows about both the daemon's HTTP seams and the durable Run machinery.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { updateCredentials } from '../config/store.js';
import type { ConfigStore } from '../config/watcher.js';
import { createRepoContext } from '../repos/index.js';
import { LocalArtifacts, registerLocalApi } from '../local-api/index.js';
import { LocalSettings } from '../local-api/settings.js';
import { RockyLinearClient } from '../linear/client.js';
import { LinearRunControl } from '../linear/control.js';
import type { AgentSessionEventHandler } from '../linear/events.js';
import { openExecution, type ExecutionIntegration } from '../run/execution.js';
import type { RunHeader } from '../run/header.js';
import type { RockyPaths } from '../config/paths.js';

/**
 * The first delegation has no repository workflow to snapshot.  It still has
 * to enter the ordinary scheduler so it gets an owned worktree, cancellation,
 * journalling and the same Linear session as every other Run.  This tiny
 * snapshot is only a durable marker: production.ts selects the shipped
 * onboarding Workflow when it sees `execution.source === 'onboarding'`.
 */
async function prepareOnboardingSnapshot(
  paths: RockyPaths,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const staging = join(paths.root, 'snapshots');
  await mkdir(staging, { recursive: true });
  const snapshotDir = await mkdtemp(join(staging, '.onboarding-'));
  try {
    await writeFile(join(snapshotDir, 'mcp.json'), '{"mcpServers":{}}\n');
    return {
      sourceCommit: 'onboarding',
      snapshotDir,
      trigger: { kind: 'linear.onDelegate' as const },
      dispose: () => rm(snapshotDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}

export interface ProductionComposition {
  execution: ExecutionIntegration;
  onAgentSessionEvent: AgentSessionEventHandler;
  registerLocalApi(app: FastifyInstance): Promise<void>;
  close(): Promise<void>;
}

function ended(run: RunHeader | undefined): boolean {
  return Boolean(
    run && ['finished', 'failed', 'cancelled'].includes(run.status),
  );
}

/** Build the real intake path; callers must not substitute an acknowledge-only handler. */
export async function createProductionComposition(options: {
  paths: RockyPaths;
  config: ConfigStore;
  /** The eventual bound address is only presentation metadata; all controls stay loopback. */
  localOrigin?: string;
}): Promise<ProductionComposition> {
  const client = new RockyLinearClient({
    auth: async () => (await options.config.readCredentials()).linear ?? {},
    save: async (tokens) => {
      await updateCredentials(options.paths, async (current) => ({
        ...current,
        linear: { ...current.linear, ...tokens },
      }));
    },
  });
  const controls = new Map<string, LinearRunControl>();

  const controlFor = async (
    runId: string,
  ): Promise<LinearRunControl | undefined> => {
    const cached = controls.get(runId);
    if (cached) return cached;
    const run = await execution.scheduler.get(runId);
    if (!run?.linear) return undefined;
    const journal = await execution.journal(runId);
    const control = new LinearRunControl({
      store: journal,
      client,
      runId,
      sessionId: run.linear.sessionId,
      issueId: run.linear.issueId,
      appUserId: run.linear.appUserId,
      runUrl: `${options.localOrigin ?? `http://localhost:${options.config.current.server.port}`}/runs/${encodeURIComponent(runId)}`,
      beforeElicitation: async () => undefined,
      parked: async () => undefined,
      ended: async () => ended(await execution.scheduler.get(runId)),
      wake: () => void execution.scheduler.poll(runId),
      cancel: () => execution.scheduler.stop(runId),
      onError: () => undefined,
    });
    controls.set(runId, control);
    return control;
  };

  const execution = await openExecution({
    paths: options.paths,
    config: () => options.config.current,
    repos: createRepoContext({
      paths: options.paths,
      identity: options.config.current.identity,
    }),
    onRefusal: async (request, message) => {
      await client.postActivity({
        sessionId: request.linear.sessionId,
        content: { type: 'error', body: message },
      });
    },
    onboarding: (_lead, signal) =>
      prepareOnboardingSnapshot(options.paths, signal),
    agentSteer: {
      open: async (runId, conversation) =>
        (await controlFor(runId))?.openConversation({
          stepKey: conversation.stepKey,
          label: conversation.label,
          ...(conversation.group === undefined
            ? {}
            : { group: conversation.group }),
        }),
      take: async (runId, stepKey) =>
        (await controlFor(runId))?.takeSteers(stepKey),
      delivered: async (runId, stepKey, ids) =>
        (await controlFor(runId))?.delivered(stepKey, ids),
      close: async (runId, stepKey) =>
        (await controlFor(runId))?.closeConversation(stepKey),
    },
  });

  const find = async (sessionId: string) => {
    const run = (await execution.scheduler.list()).find(
      (candidate) => candidate.linear?.sessionId === sessionId,
    );
    return run ? controlFor(run.runId) : undefined;
  };
  const created = async (event: Parameters<AgentSessionEventHandler>[0]) => {
    if (!event.issueId)
      throw new Error('A delegated Agent session must name its Linear issue');
    const issue = await client.issue(event.issueId);
    const admitted = await execution.delegate({
      requestId: event.sessionId,
      issue: {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
        url: issue.url,
      },
      branch: issue.identifier.toLowerCase(),
      team: issue.teamId,
      linear: {
        issueId: issue.id,
        teamId: issue.teamId,
        organizationId: event.organizationId,
        appUserId: event.appUserId,
        sessionId: event.sessionId,
      },
    });
    if (admitted.kind === 'refused') return;
    const control = await controlFor(admitted.run.runId);
    const origin =
      options.localOrigin ??
      `http://localhost:${options.config.current.server.port}`;
    await client.acknowledgeSession(
      event.sessionId,
      `${origin}/runs/${encodeURIComponent(admitted.run.runId)}`,
    );
    await control?.reconcile();
  };
  // A created delivery establishes the durable ownership record.  Prompted
  // deliveries are subsequently checked against that record before control
  // intake, rather than against an unpersisted process-local value.
  const handler: AgentSessionEventHandler = async (event) => {
    if (event.action === 'created') {
      await created(event);
      return;
    }
    const control = await find(event.sessionId);
    const run = (await execution.scheduler.list()).find(
      (row) => row.linear?.sessionId === event.sessionId,
    );
    if (
      !control ||
      !run?.linear ||
      run.linear.appUserId !== event.appUserId ||
      run.linear.organizationId !== event.organizationId
    )
      throw new Error(
        'Linear event does not belong to this installed app and workspace',
      );
    await control.prompted(event);
  };

  return {
    execution,
    onAgentSessionEvent: handler,
    registerLocalApi: async (app) => {
      await registerLocalApi(app, {
        runs: {
          list: () => execution.scheduler.list(),
          get: (id) => execution.scheduler.get(id),
          journal: async (id) =>
            (await (await execution.journal(id)).read()).entries,
        },
        artifacts: new LocalArtifacts(options.paths),
        settings: new LocalSettings({
          paths: options.paths,
          boundServer: options.config.current.server,
        }),
        currentCheckpoint: async (id) =>
          (await controlFor(id))?.currentCheckpoint(),
        answer: async (id, input) => {
          const control = await controlFor(id);
          if (!control) throw new Error(`Run ${id} has no Linear control`);
          return control.answer({ ...input, requestId: randomUUID() });
        },
        steer: async (id, input) => {
          const control = await controlFor(id);
          if (!control) throw new Error(`Run ${id} has no Linear control`);
          const receipt = await control.steer(input);
          return {
            requestId: receipt.requestId,
            message: receipt.message,
            receivedAt: receipt.receivedAt,
            state: receipt.state,
            targets: receipt.targets,
          };
        },
        steers: async (id) => {
          const control = await controlFor(id);
          const receipts = control ? await control.steers() : [];
          return receipts.map((receipt) => ({
            requestId: receipt.requestId,
            message: receipt.message,
            receivedAt: receipt.receivedAt,
            state: receipt.state,
            targets: receipt.targets,
          }));
        },
      });
    },
    close: async () => controls.clear(),
  };
}
