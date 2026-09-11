/**
 * The production composition root.  This is deliberately the only place that
 * knows about both the daemon's HTTP seams and the durable Run machinery.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import type { ConfigStore } from '../config/watcher.js';
import { createRepoContext } from '../repos/index.js';
import {
  LocalArtifacts,
  LocalProfiles,
  registerLocalApi,
} from '../local-api/index.js';
import { LocalSettings } from '../local-api/settings.js';
import { LocalConnections } from '../local-api/connections.js';
import type { OAuthCallbackBroker } from '../linear/callback.js';
import { createInstanceLinearClient } from '../linear/instance-client.js';
import { LinearOAuthError } from '../linear/oauth.js';
import { LinearNotConfiguredError } from '../linear/client.js';
import { LinearRunControl, inspectLinearControl } from '../linear/control.js';
import { IntakeFailures } from '../linear/intake-failures.js';
import type { AgentSessionEventHandler } from '../linear/events.js';
import { openExecution, type ExecutionIntegration } from '../run/execution.js';
import type { RunHeader } from '../run/header.js';
import { readJournal } from '../run/journal.js';
import type { RockyPaths } from '../config/paths.js';
import {
  agentDiagramGenerator,
  WorkflowDiagrams,
} from '../workflow-diagrams.js';

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
  registerLocalApi(
    app: FastifyInstance,
    oauth?: OAuthCallbackBroker,
  ): Promise<void>;
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
  const client = createInstanceLinearClient(options.paths);
  const controls = new Map<string, LinearRunControl>();
  const intakeFailures = new IntakeFailures(options.paths);

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
      // A browser-fired manual Run has no Agent Session to post into.
      if (!request.linear) return;
      await client.postActivity({
        sessionId: request.linear.sessionId,
        content: { type: 'error', body: message },
      });
    },
    onboarding: (_lead, signal) =>
      prepareOnboardingSnapshot(options.paths, signal),
    checkpoint: async (runId, stepKey, request) => {
      const control = await controlFor(runId);
      if (!control) throw new Error(`Run ${runId} has no Linear control`);
      return control.checkpoint(stepKey, request);
    },
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

  const ownsLiveSession = (run: RunHeader, sessionId: string) =>
    !ended(run) && run.linear?.sessionId === sessionId;
  const find = async (sessionId: string) => {
    const run = (await execution.scheduler.list()).find((candidate) =>
      ownsLiveSession(candidate, sessionId),
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
    try {
      if (event.action === 'created') {
        await created(event);
        return;
      }
      const control = await find(event.sessionId);
      const run = (await execution.scheduler.list()).find((row) =>
        ownsLiveSession(row, event.sessionId),
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
    } catch (error) {
      await intakeFailures.record(
        event,
        error instanceof LinearOAuthError ||
          error instanceof LinearNotConfiguredError
          ? 'linear-auth'
          : undefined,
      );
      throw error;
    }
  };

  return {
    execution,
    onAgentSessionEvent: handler,
    registerLocalApi: async (app, oauth) => {
      // A failed writer must remain closed to writes, but its durable prefix
      // still needs to be inspectable. Never repair or reopen it from the UI.
      const runJournal = (id: string) =>
        readJournal(options.paths.run(id).journal);
      const controlView = async (id: string) =>
        inspectLinearControl(
          (await runJournal(id)).getControl('linear:control'),
        );
      const connections = new LocalConnections(options.paths, { oauth });
      app.addHook('preClose', () => connections.close());
      const diagrams = new WorkflowDiagrams({
        paths: options.paths,
        generate: agentDiagramGenerator(options.paths, options.config),
        onError: () =>
          app.log.warn('Workflow diagram cache could not be refreshed.'),
      });
      app.addHook('onClose', () => diagrams.close());
      await registerLocalApi(app, {
        tailscaleOrigin: () => options.config.current.server.tailscaleOrigin,
        runs: {
          list: () => execution.scheduler.list(),
          get: async (id) => {
            const run = await execution.scheduler.get(id);
            if (!run || run.status !== 'failed') return run;
            const terminal = (await runJournal(id)).getControl(
              `linear-mirror:${id}:terminal`,
            );
            if (
              terminal &&
              typeof terminal === 'object' &&
              'content' in terminal &&
              terminal.content &&
              typeof terminal.content === 'object' &&
              'body' in terminal.content &&
              typeof terminal.content.body === 'string'
            ) {
              const original = terminal.content.body.split('\n\n')[0];
              if (
                original.startsWith('Rocky Run failed at Step ') &&
                !original.includes(run.error?.message ?? '\0')
              )
                return {
                  ...run,
                  error: {
                    name: run.error?.name ?? 'Error',
                    message: `${original}\n\nReporting error: ${run.error?.message ?? 'Not recorded'}`,
                  },
                };
            }
            return run;
          },
          journal: async (id) => (await runJournal(id)).entries,
        },
        artifacts: new LocalArtifacts(options.paths),
        settings: new LocalSettings({
          paths: options.paths,
          boundServer: options.config.current.server,
        }),
        profiles: new LocalProfiles(options.paths),
        connections,
        diagrams,
        currentCheckpoint: async (id) => (await controlView(id)).checkpoint,
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
          const receipts = (await controlView(id)).steers;
          return receipts.map((receipt) => ({
            requestId: receipt.requestId,
            message: receipt.message,
            receivedAt: receipt.receivedAt,
            state: receipt.state,
            targets: receipt.targets,
          }));
        },
        intakeFailures: () => intakeFailures.list(),
        recoverSession: async (runId) => {
          const run = await execution.scheduler.recoverSession(runId);
          if (!run.linear)
            throw new Error(`${runId}: released session identity is missing`);
          return {
            runId: run.runId,
            issueIdentifier: run.issue.identifier,
            sessionId: run.linear.sessionId,
          };
        },
        manual: async ({ trigger, issue: identifier, profileId }) => {
          const issue = await client.issue(identifier);
          const admitted = await execution.manual(trigger, {
            requestId: randomUUID(),
            issue: {
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              labels: issue.labels,
              url: issue.url,
            },
            branch: issue.identifier.toLowerCase(),
            team: issue.teamId,
            ...(profileId === undefined ? {} : { profileId }),
          });
          if (admitted.kind === 'refused')
            return { kind: 'refused' as const, reason: admitted.message };
          if (admitted.kind !== 'started')
            return {
              kind: 'refused' as const,
              reason: `Manual Trigger did not start a new Run (${admitted.kind}).`,
              runId: admitted.run.runId,
            };
          return { kind: 'started' as const, runId: admitted.run.runId };
        },
      });
      diagrams.start();
    },
    close: async () => controls.clear(),
  };
}
