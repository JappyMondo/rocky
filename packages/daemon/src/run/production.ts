import { z } from 'zod';
import { PublicReviews } from '../review-report/public.js';
import {
  recapPullRequests,
  recapRepositoryEvidence,
  recapWorkflowEvidence,
} from '../review-report/evidence.js';
import {
  sourceControlEnv,
  sourceControlToken,
} from '../config/source-control.js';
import { profileEnv } from '../config/execution-env.js';
import type { ScmOps, ScmPr, VisualRecapOptions } from '@rocky/sdk';
import type { Answer } from '@rocky/local-contracts';
import type { BootContext, StepOutcome } from './replay.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { LocalArtifacts } from '../local-api/artifacts.js';
import {
  generateReport,
  recapId,
  reportMarkdown,
} from '../review-report/reporter.js';
import { reviewRevision } from '../review-report/workspace.js';
import { fileURLToPath } from 'node:url';

import { expandHarness } from '../config/expand.js';
import type { RockyPaths } from '../config/paths.js';
import type { InstanceConfig } from '../config/schema.js';
import { readCredentials } from '../config/store.js';
import { LinearRunMirror } from '../linear/mirror.js';
import { createInstanceLinearClient } from '../linear/instance-client.js';
import { preflightMcp, readMcpConfig, type McpConfig } from '../mcp/index.js';
import {
  createGitHubScm,
  createGitLabScm,
  createScm,
  runPreflight,
} from '../scm/index.js';
import { createAgent, describeAgentEvent, type AgentOptions } from './agent.js';
import { readJournal, type JournalEntry } from './journal.js';
import { loadSnapshotWorkflow } from './loading/loader.js';
import { validateSnapshotTriggers } from './loading/validate.js';
import { loadMcpRuntime, type McpRuntime } from './mcp-contract.js';
import { WorkflowRuntime, type WorkflowRuntimeOptions } from './lifecycle.js';
import type { BootRequest } from './worker.js';
import { recoverWithAgent } from './recovery-agent.js';
import { prepareCodexEnvironment } from './codex-environment.js';
import { currentRunModels } from './current-models.js';
import { currentRunSourceControl } from './source-control.js';

function scmProject(url: string): {
  platform: 'github' | 'gitlab';
  project: string;
} {
  const match = url.match(
    /(?:github|gitlab)\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/i,
  );
  if (!match)
    throw new Error(
      `Unsupported SCM remote ${url}; configure a GitHub or GitLab repository URL.`,
    );
  const platform = /gitlab\.com/i.test(url) ? 'gitlab' : 'github';
  return { platform, project: match[1] };
}

/** Construct adapters and check authority only when a Workflow uses SCM. */
function lazyScm(load: () => Promise<ScmOps>): ScmOps {
  let pending: Promise<ScmOps> | undefined;
  const invoke = async <T>(operation: (scm: ScmOps) => Promise<T>) =>
    operation(await (pending ??= load()));
  return {
    openPr: (...args) => invoke((scm) => scm.openPr(...args)),
    markDraft: (...args) => invoke((scm) => scm.markDraft(...args)),
    waitForCi: (...args) => invoke((scm) => scm.waitForCi(...args)),
    retryFailedJobs: (...args) => invoke((scm) => scm.retryFailedJobs(...args)),
    updateBranch: (...args) => invoke((scm) => scm.updateBranch(...args)),
    checkMergeReady: (...args) => invoke((scm) => scm.checkMergeReady(...args)),
    armAutoMerge: (...args) => invoke((scm) => scm.armAutoMerge(...args)),
    reviewThreads: (...args) => invoke((scm) => scm.reviewThreads(...args)),
    replyToThread: (...args) => invoke((scm) => scm.replyToThread(...args)),
  };
}

const effectId = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

function shippedContentUrl(path: string): URL {
  // Source Boots run from src/run; the packed esbuild entry runs from dist.
  // The raw content tree is deliberately copied beside the latter, rather
  // than bundled, so seeded files remain inspectable TypeScript.
  const source = new URL(`../../content/${path}`, import.meta.url);
  if (existsSync(fileURLToPath(source))) return source;
  return new URL(`../content/${path}`, import.meta.url);
}

function onboardingModuleUrl(): URL {
  // Node deliberately will not type-strip a .ts file below node_modules.
  // The package bundles this daemon-owned runner, while source Boots retain
  // the inspectable TypeScript module during development.
  const packed = new URL('../dist/onboarding.js', import.meta.url);
  return existsSync(fileURLToPath(packed))
    ? packed
    : shippedContentUrl('onboarding.ts');
}

export interface ProductionRuntimeOptions {
  paths: RockyPaths;
  config(): InstanceConfig;
  request(request: BootRequest): Promise<unknown>;
  onEvent?: AgentOptions['onEvent'];
  steer?: AgentOptions['steer'];
  /** Harness #20 is injectable for production-seam tests and future adapters. */
  adapterFor?: AgentOptions['adapterFor'];
  /** SCM and Linear adapters receive branch-local Steps and cancellation unchanged. */
  external?: WorkflowRuntimeOptions['external'];
  preflight?: WorkflowRuntimeOptions['beforeWorkflow'];
}

/** Created only inside an owned Boot process; no Workflow import reaches HTTP. */
export function createProductionRuntime(
  options: ProductionRuntimeOptions,
): WorkflowRuntime {
  const scmContexts = new WeakMap<BootContext, ScmOps>();
  const scmContext = (steps: BootContext, load: () => Promise<ScmOps>) => {
    let context = scmContexts.get(steps);
    if (!context) {
      context = lazyScm(load);
      scmContexts.set(steps, context);
    }
    return context;
  };
  let env: NodeJS.ProcessEnv = {};
  const registeredTranscripts = new Set<string>();
  let credentials: Awaited<ReturnType<typeof readCredentials>>;
  let activeRun:
    Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0] | undefined;
  // A direct Runtime construction is useful for isolated Workflow tests. A
  // real admitted Linear Run has an access token (hydration could not happen
  // otherwise), so only those Runs receive network-backed production services.
  let servicesEnabled = false;
  let manualIssue: { issueId: string; teamId: string } | undefined;
  let legacyPreflight = false;
  let mcp: Promise<{ runtime: McpRuntime; config: unknown }> | undefined;
  // A mirror has a small in-memory coalescing buffer. Keep one per Run rather
  // than constructing one per effect so streamed status is actually flushed.
  const mirrors = new Map<string, LinearRunMirror>();
  let continuations = 0;
  let completionRetry: string | undefined;
  const mirrorFlushes = new Map<string, ReturnType<typeof setTimeout>>();
  const linearClient = createInstanceLinearClient(options.paths);
  const mirrorFor = (
    run: Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0],
  ) => {
    const identity = run.linear ?? manualIssue;
    if (!identity)
      throw new Error(`${run.runId}: missing Linear issue identity`);
    const mirrorId = `${run.runId}:${continuations}:${completionRetry ?? ''}`;
    const existing = mirrors.get(mirrorId);
    if (existing) return existing;
    const mirror = new LinearRunMirror({
      runId: run.runId,
      completionAttempt: continuations,
      completionRetry,
      issueId: identity.issueId,
      sessionId: run.linear?.sessionId,
      teamId: identity.teamId,
      localOrigin: `http://localhost:${options.config().server.port}`,
      client: linearClient,
      store: {
        get: async (key) => options.request({ kind: 'control-get', key }),
        put: async (key, value) => {
          await options.request({ kind: 'control-put', key, value });
        },
      },
    });
    mirrors.set(mirrorId, mirror);
    return mirror;
  };
  const flushMirrorSoon = (runId: string, mirror: LinearRunMirror) => {
    if (mirrorFlushes.has(runId)) return;
    mirrorFlushes.set(
      runId,
      setTimeout(() => {
        mirrorFlushes.delete(runId);
        // Linear receives a coalesced current status, never raw Transcript
        // chunks. The durable UI preview remains the source for full output.
        void mirror.flushStatus().catch(() => undefined);
      }, 300),
    );
  };
  const summaryFor = (entry: JournalEntry) => {
    if (entry.status === 'running') {
      const live =
        entry.progress &&
        typeof entry.progress === 'object' &&
        !Array.isArray(entry.progress) &&
        'live' in entry.progress &&
        entry.progress.live &&
        typeof entry.progress.live === 'object' &&
        !Array.isArray(entry.progress.live)
          ? entry.progress.live
          : undefined;
      if (live && 'summary' in live && typeof live.summary === 'string')
        return live.summary;
      return 'Running…';
    }
    if (entry.status === 'waiting') return 'Waiting for input…';
    if (entry.status === 'failed') return entry.error?.message ?? 'Failed.';
    const result = entry.result;
    if (
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      typeof (result as { summary?: unknown }).summary === 'string'
    )
      return (result as { summary: string }).summary;
    return 'Completed.';
  };
  const mirrorStep = (entry: JournalEntry) => {
    // The mirror begins at the durable linear.start Step. Earlier framework
    // preparation predates the acknowledged Linear session and cannot be
    // presented there honestly.
    if (!servicesEnabled || !activeRun?.linear || entry.step === 'linear.start')
      return;
    const mirror = mirrorFor(activeRun);
    const frame = {
      stepId: String(entry.seq),
      title: entry.label ?? entry.step,
      summary: summaryFor(entry),
    };
    if (entry.status === 'done' || entry.status === 'failed') {
      void mirror
        .settle({
          ...frame,
          outcome: entry.status === 'done' ? 'completed' : 'failed',
        })
        .catch(() => undefined);
      return;
    }
    mirror.status(frame);
    flushMirrorSoon(activeRun.runId, mirror);
  };
  const scmFor = async (
    run: Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0],
    signal: AbortSignal,
  ) => {
    if (!run.execution) throw new Error(`${run.runId}: missing frozen members`);
    return Promise.all(
      run.execution.members.map(async (member) => {
        const memberSourceControl = await currentRunSourceControl(
          options.paths,
          options.config(),
          run,
          member.name,
        );
        const source = scmProject(member.url);
        const memberEnv = profileEnv(
          { profile: run.profile, repo: member.name },
          credentials,
        );
        const cliSelected =
          Object.keys(memberSourceControl[source.platform] ?? {}).length > 0;
        const token = await sourceControlToken(
          source.platform,
          cliSelected
            ? sourceControlEnv(memberSourceControl, {
                ...process.env,
                ...memberEnv,
              })
            : { ...process.env, ...memberEnv },
          { signal, cwd: options.paths.root },
        );
        const input = {
          repo: {
            id: member.name,
            project: source.project,
            baseBranch: member.baseBranch,
          },
          branch: run.branch,
          token,
          signal,
        };
        return source.platform === 'github'
          ? createGitHubScm(input)
          : createGitLabScm(input);
      }),
    );
  };
  return new WorkflowRuntime({
    paths: options.paths,
    read: readJournal,
    append: async (_path, entry, appendOptions) => {
      await options.request({ kind: 'append', entry, options: appendOptions });
      mirrorStep(entry);
      if (activeRun) {
        const register = async (
          item: JournalEntry,
          prefix = '',
        ): Promise<void> => {
          const key = `${prefix}${item.seq}`;
          const identity = `${activeRun?.runId}:${key}`;
          if (item.step === 'agent' && !registeredTranscripts.has(identity)) {
            try {
              if (!activeRun) return;
              await new LocalArtifacts(options.paths).registerTranscript(
                activeRun.runId,
                key,
                `${key.replaceAll('/', '-')}.jsonl`,
              );
              registeredTranscripts.add(identity);
            } catch {
              /* Before the first event, the Transcript does not exist yet. */
            }
          }
          for (const [index, branch] of (
            item.parallel?.branches ?? []
          ).entries())
            for (const child of branch)
              await register(child, `${key}/${index}/`);
        };
        await register(entry);
      }
    },
    loadWorkflow: async (run, signal) => {
      if (!run.execution)
        throw new Error(
          `${run.runId}: missing immutable execution metadata; re-delegate through the production admission service`,
        );
      signal.throwIfAborted();
      if (run.profile) {
        const [sourceControl, models] = await Promise.all([
          currentRunSourceControl(options.paths, options.config(), run),
          run.execution.commandTest
            ? Promise.resolve({})
            : currentRunModels(options.paths, run),
        ]);
        run.profile = {
          ...run.profile,
          sourceControl,
          ...(models ? { models } : {}),
        };
      }
      credentials = await readCredentials(options.paths);
      // Preserve the Step sequence of Runs admitted before split preflight.
      // Both settled and interrupted legacy probes select the old path.
      legacyPreflight = (
        await readJournal(options.paths.run(run.runId).journal)
      ).entries.some((entry) => entry.seq === 2 && entry.step === 'preflight');
      // Session effects retain their original step ordering. Manual issue runs
      // resolve only a ticket identity; they never fabricate an agent session.
      servicesEnabled = Boolean(credentials.linear?.accessToken && run.linear);
      manualIssue = undefined;
      if (
        credentials.linear?.accessToken &&
        !run.linear &&
        !run.execution.commandTest &&
        run.issue.url
      ) {
        const schema = z.object({
          issueId: z.string(),
          teamId: z.string(),
          identifier: z.string(),
          url: z.string(),
        });
        const saved = await options.request({
          kind: 'control-get',
          key: 'manual:linear-issue',
        });
        const issue =
          saved === undefined
            ? await linearClient.issue(run.issue.identifier)
            : undefined;
        const identity = schema.parse(
          saved ?? {
            issueId: issue?.id,
            teamId: issue?.teamId,
            identifier: issue?.identifier,
            url: issue?.url,
          },
        );
        if (
          identity.identifier !== run.issue.identifier ||
          identity.url !== run.issue.url
        )
          throw new Error(
            'Manual run issue identity does not match its admitted ticket.',
          );
        if (saved === undefined)
          await options.request({
            kind: 'control-put',
            key: 'manual:linear-issue',
            value: identity,
          });
        manualIssue = identity;
      }
      activeRun = run;
      env = {
        ...sourceControlEnv(run.profile?.sourceControl, {
          ...process.env,
          ...profileEnv(run, credentials),
        }),
        ROCKY_NODE: process.execPath,
        ROCKY_MERMAID_CHECK: fileURLToPath(
          new URL('./mermaid-check.js', import.meta.url),
        ),
        ROCKY_RUN_DIR: options.paths.run(run.runId).dir,
        ROCKY_LEAD_REPO: join(
          options.paths.run(run.runId).workspaceDir,
          run.execution.members.find((member) => member.lead)?.path ?? run.repo,
        ),
        ROCKY_SCREENSHOT_DIR: options.paths.run(run.runId).screenshotsDir,
        ROCKY_PORT: String(run.ports[0] ?? ''),
      };
      if (run.profile?.configurationVersion) {
        // The workspace writes effective identity/signing/SSH config per repo.
        // A process-wide Git override would otherwise defeat those settings
        // whenever an agent changes directories into another member.
        for (const key of Object.keys(env)) {
          if (
            /^GIT_(AUTHOR_|COMMITTER_|CONFIG_)/.test(key) ||
            key === 'GIT_SSH_COMMAND'
          )
            delete env[key];
        }
      }
      mcp = undefined;
      if (!run.execution.commandTest)
        await recoverWithAgent({
          paths: options.paths,
          config: options.config(),
          run,
          env,
          signal,
          request: options.request,
          adapterFor: options.adapterFor,
        });
      if (run.execution.source === 'onboarding') {
        // Content intentionally remains a shipped, inspectable tree rather
        // than part of the daemon's import graph.  Keeping the specifier in a
        // value also prevents TypeScript from folding that tree into dist.
        const onboardingModule = onboardingModuleUrl().href;
        const { createOnboarding } = await import(onboardingModule);
        const shippedDir = fileURLToPath(shippedContentUrl('.rocky/'));
        const lead = run.execution.members.find((member) => member.lead);
        if (!lead)
          throw new Error(
            `${run.runId}: onboarding has no frozen lead repository`,
          );
        const linear = run.linear;
        if (!linear)
          throw new Error(`${run.runId}: onboarding has no Linear identity`);
        return createOnboarding({
          repo: join(options.paths.run(run.runId).workspaceDir, lead.path),
          shippedDir,
          teamStates: async () => {
            const client = createInstanceLinearClient(options.paths, {
              signal,
            });
            return client.workflowStates(linear.teamId);
          },
          validate: async (directory: string) => {
            await validateSnapshotTriggers(directory, { signal });
          },
        });
      }
      const latestRetry = await options.request({
        kind: 'control-get',
        key: 'retry:latest',
      });
      completionRetry =
        latestRetry &&
        typeof latestRetry === 'object' &&
        'requestId' in latestRetry &&
        typeof latestRetry.requestId === 'string'
          ? latestRetry.requestId
          : undefined;
      continuations = Number(
        (await options.request({
          kind: 'control-get',
          key: 'review:continuations',
        })) ?? 0,
      );
      return loadSnapshotWorkflow(
        options.paths.run(run.runId).snapshotDir,
        run.execution.trigger,
        continuations,
        ((await options.request({
          kind: 'control-get',
          key: 'flow:repairs',
        })) ?? []) as import('@rocky/local-contracts').FlowRepairRevision[],
      );
    },
    beforeWorkflow: async (run, steps, signal) => {
      await steps.step('workspace', {}, async () => ({
        status: 'done',
        result: await options.request({ kind: 'workspace' }),
      }));
      if (servicesEnabled) {
        // Onboarding is already an acknowledged Agent Session and reports its
        // seed PR through ctx.post; its intake owns the initial acknowledgement.
        if (run.execution?.source !== 'onboarding') {
          const mirror = mirrorFor(run);
          await steps.step('linear.start', {}, async () => {
            await mirror.start();
            return { status: 'done' as const, result: null };
          });
        }
        // MCP authentication is relevant to agent work even without a PR.
        // SCM completion authority is checked lazily when content uses SCM.
        if (run.execution?.source !== 'onboarding') {
          await runPreflight(steps, {
            ...(legacyPreflight ? {} : { scope: 'mcp' as const }),
            members: legacyPreflight ? await scmFor(run, signal) : [],
            signal,
            refreshMcp: async (refreshSignal) =>
              preflightMcp(
                (await readMcpConfig(
                  join(options.paths.run(run.runId).snapshotDir, 'mcp.json'),
                )) as McpConfig,
                { paths: options.paths, signal: refreshSignal },
              ),
          });
        }
      }
      await options.preflight?.(run, steps, signal);
    },
    env: () => env,
    external: (run, steps, signal, approvals) => {
      const resolveHarness = (name: 'claude-code' | 'opencode' | 'codex') => {
        const settings = expandHarness(
          name,
          options.config().harnesses[name] ?? {},
          env,
        );
        return {
          command:
            settings.command ?? (name === 'claude-code' ? 'claude' : name),
          env: sourceControlEnv(run.profile?.sourceControl, {
            ...env,
            ...settings.env,
          }),
          sessionStorage:
            settings.sessionStorage ??
            (name === 'codex' ? ('codex' as const) : ('rocky' as const)),
        };
      };
      const runAgent = createAgent(steps, {
        screenshotDir: options.paths.run(run.runId).screenshotsDir,
        snapshotDir: options.paths.run(run.runId).snapshotDir,
        cwd: options.paths.run(run.runId).workspaceDir,
        gitMetadataDirectories: run.execution?.members.map((member) =>
          options.paths.repo(member.name),
        ),
        sessionDir: options.paths.run(run.runId).sessionsDir,
        prepareEnvironment: async (harness, tools, agentEnv, agentSignal) =>
          harness === 'codex' && tools.includes('bash')
            ? prepareCodexEnvironment(
                options.paths.run(run.runId).workspaceDir,
                agentEnv,
                agentSignal,
              )
            : { env: {}, dispose: async () => undefined },
        harness: 'claude-code',
        harnesses: {
          get 'claude-code'() {
            return resolveHarness('claude-code');
          },
          get opencode() {
            return resolveHarness('opencode');
          },
          get codex() {
            return resolveHarness('codex');
          },
        },
        resolveServers: async (names, attemptSignal) => {
          const prepared = await (mcp ??= (async () => {
            const runtime = await loadMcpRuntime();
            const declarations = await runtime.readMcpConfig(
              join(options.paths.run(run.runId).snapshotDir, 'mcp.json'),
            );
            return {
              runtime,
              config: runtime.expandMcpConfig(declarations, {
                env,
                run: {
                  runDir: options.paths.run(run.runId).dir,
                  screenshotDir: options.paths.run(run.runId).screenshotsDir,
                  port: run.ports[0] ?? 0,
                },
              }),
            };
          })());
          return prepared.runtime.resolveMcpServers(prepared.config, names, {
            paths: options.paths,
            signal: attemptSignal,
          });
        },
        adapterFor: options.adapterFor,
        onEvent: (stepKey, event, sessionId) => {
          options.onEvent?.(stepKey, event, sessionId);
          if (!servicesEnabled) return;
          const mirror = mirrorFor(run);
          mirror.status({
            stepId: stepKey,
            title: 'Agent',
            summary: describeAgentEvent(event),
          });
          flushMirrorSoon(run.runId, mirror);
        },
        steer: options.steer,
      });
      const artifacts = new LocalArtifacts(options.paths);
      const revisionFor = async (repo: string, head?: string) => {
        const member = run.execution?.members.find(
          (member) => member.name === repo,
        );
        if (!member) throw new Error(`Unknown Run repository ${repo}`);
        return reviewRevision(
          join(options.paths.run(run.runId).workspaceDir, member.path),
          run.branch,
          member.baseBranch,
          head,
          env,
        );
      };
      const visualRecap = async (
        recap: VisualRecapOptions,
        enhanced = true,
      ) => {
        const { pr } = recap;
        if (!pr && !recap.diff?.trim() && !recap.deliverable?.trim())
          throw new Error(
            'ctx.visualRecap requires a PR, diff, or deliverable',
          );
        const version = run.execution?.recapVersion ?? 1;
        const id = recapId({ ...recap, enhanced, version });
        const origin = (
          options.config().server.tailscaleOrigin ||
          `http://localhost:${options.config().server.port}`
        ).replace(/\/$/, '');
        const publicOrigin = options.config().publicUrl;
        const publicReviews = new PublicReviews(options.paths);
        const linkFor = async (
          reportId: string,
          previouslyPublished: boolean,
        ) => {
          const key = `review-report:${reportId}:url`;
          const saved = await options.request({ kind: 'control-get', key });
          if (typeof saved === 'string') return { id: reportId, url: saved };
          // Old runs used private URLs in hashed SCM inputs and checkpoints.
          // Keep that value on replay; sharing is an independent side effect.
          const url =
            publicOrigin && !previouslyPublished
              ? await publicReviews.url(run.runId, reportId, publicOrigin)
              : `${origin}/runs/${encodeURIComponent(run.runId)}?report=${reportId}`;
          await options.request({ kind: 'control-put', key, value: url });
          return { id: reportId, url };
        };
        const publishedKey = `review-report:${id}:published`;
        const revision = pr
          ? await steps.step(
              'reviewReport.revision',
              { label: 'Verify pushed PR changes' },
              async () => ({
                status: 'done',
                result: await revisionFor(pr.repo, pr.headSha),
              }),
            )
          : { diff: recap.diff ?? '' };
        const published = await steps.step(
          'reviewReport.published',
          { label: 'Check report publication' },
          async () => ({
            status: 'done',
            result:
              (await options.request({
                kind: 'control-get',
                key: publishedKey,
              })) === true ||
              (!enhanced &&
                (await options.request({
                  kind: 'control-get',
                  key: `review-report:${recapId({ ...recap, enhanced: true, version })}:published`,
                })) === true),
          }),
        );
        if (published) {
          // Marking ready can reuse an enhanced report. Its legacy ID has no
          // artifact, so share and return the report that was actually saved.
          const reports = await artifacts.listReports(run.runId);
          const cached =
            reports.find((report) => report.id === id) ??
            (!enhanced &&
              reports.find(
                (report) =>
                  report.id === recapId({ ...recap, enhanced: true, version }),
              ));
          const report = cached || (await artifacts.readReport(run.runId, id));
          if (publicOrigin) await publicReviews.publish(report, publicOrigin);
          return {
            ...(await linkFor(report.id, true)),
            decision: report.decision,
          };
        }
        const result = await linkFor(
          id,
          (await options.request({
            kind: 'control-get',
            key: publishedKey,
          })) === true,
        );
        await mkdir(options.paths.run(run.runId).screenshotsDir, {
          recursive: true,
        });
        const journal = await readJournal(options.paths.run(run.runId).journal);
        const scope = journal.entries
          .filter((entry) => entry.step === 'agent' && entry.status === 'done')
          .map((entry) => entry.result)
          .findLast(
            (result) =>
              result &&
              typeof result === 'object' &&
              'status' in result &&
              result.status === 'clear' &&
              'scope' in result,
          );
        const previewStep = recap.deliverable
          ? journal.entries.findLast(
              (entry) =>
                entry.status === 'done' &&
                entry.result &&
                typeof entry.result === 'object' &&
                'body' in entry.result &&
                entry.result.body === recap.deliverable,
            )
          : undefined;
        const report = await generateReport({
          steps,
          agent: runAgent,
          agents: recap.agents,
          artifacts,
          runId: run.runId,
          pr,
          pullRequests: recapPullRequests(journal.entries),
          ...revision,
          enhanced,
          version,
          workflowEvidence:
            version === 2
              ? {
                  ...recapWorkflowEvidence(journal.entries, pr?.headSha),
                  repositories: await recapRepositoryEvidence({
                    workspaceDir: options.paths.run(run.runId).workspaceDir,
                    branch: run.branch,
                    primaryRepo: pr?.repo,
                    members: run.execution?.members ?? [],
                    env,
                  }),
                }
              : undefined,
          deliverable: recap.deliverable,
          title: recap.title,
          issue: run.issue,
          screenshotDir: options.paths.run(run.runId).screenshotsDir,
          workspace: run.execution?.members,
          workflow: run.profile?.workflow.source,
          previewUrl: previewStep
            ? `http://127.0.0.1:${options.config().server.port}/runs/${encodeURIComponent(run.runId)}#step=${previewStep.seq}`
            : undefined,
          scope: recap.scope ?? scope,
          port: run.ports[0],
          agentOptions: {
            harness: run.profile?.grants.harness ?? 'opencode',
            tools: ['read', 'bash'],
            mcp: run.profile?.grants.mcp ?? [],
            ...recap.agent,
          },
        });
        const images: Record<string, string> = {};
        for (const shot of (enhanced ? [] : report.visuals).flatMap(
          (visual) => visual.screenshots,
        )) {
          images[shot.id] = await steps.step(
            'reviewReport.upload',
            { label: `Upload ${shot.caption}` },
            async () => {
              const { bytes, contentType } = await artifacts.readScreenshot(
                shot.id,
              );
              const uploaded = await linearClient.uploadFile({
                filename: `${shot.id}.${contentType.split('/')[1]}`,
                contentType,
                data: new Uint8Array(bytes),
              });
              return { status: 'done', result: uploaded.assetUrl };
            },
          );
        }
        if (publicOrigin) await publicReviews.publish(report, publicOrigin);
        const markdown = reportMarkdown(report, origin, images, result.url);
        await steps.step(
          'reviewReport.publish',
          {
            label: pr
              ? 'Post review report to Linear and PR'
              : 'Post review report to Linear',
          },
          async () => {
            // Re-check after a potentially long visual sweep: stale evidence must never mark another head ready.
            if (pr) {
              await revisionFor(pr.repo, pr.headSha);
              const adapter = (await scmFor(run, signal)).find(
                (adapter) => adapter.repo.id === pr.repo,
              );
              if (!adapter)
                throw new Error(`Unknown SCM repository ${pr.repo}`);
              await adapter.postReviewReport(
                pr,
                markdown,
                `${run.runId}:${report.id}`,
              );
            }
            await mirrorFor(run).comment(`report:${report.id}`, markdown);
            await options.request({
              kind: 'control-put',
              key: publishedKey,
              value: true,
            });
            return {
              status: 'done',
              result: {
                reportId: report.id,
                ...(pr ? { headSha: pr.headSha } : {}),
              },
            };
          },
        );
        return { ...result, decision: report.decision };
      };
      const onReady = async (pr: ScmPr) => {
        await visualRecap({ pr }, false);
      };
      return {
        checkpoint: async (request, stepKey) =>
          options.request({
            kind: 'checkpoint',
            stepKey,
            request: {
              ...request,
              digest: {
                diffStat: 'See run report',
                ci: 'See run activity',
                unresolved: 0,
              },
            },
          }) as Promise<StepOutcome<Answer>>,
        ...options.external?.(run, steps, signal, approvals),
        ...(servicesEnabled || manualIssue
          ? {
              visualRecap,
              comment: (markdown: string) =>
                steps
                  .step('linear.comment', {}, async () => {
                    const id = await mirrorFor(run).comment(
                      effectId(markdown),
                      markdown,
                    );
                    return {
                      status: 'done',
                      result: {
                        id,
                        ...(run.linear ? { issueId: run.linear.issueId } : {}),
                      },
                    };
                  })
                  .then(() => undefined),
              post: async (markdown: string) => {
                if (run.linear)
                  await mirrorFor(run).post(
                    effectId(`post:${markdown}`),
                    markdown,
                  );
                else
                  await mirrorFor(run).comment(
                    effectId(`post:${markdown}`),
                    markdown,
                  );
              },
              linear: {
                setState: async (name: string, transitionId?: string) =>
                  mirrorFor(run).setState(
                    `state:${transitionId ?? name}`,
                    name,
                  ),
              },
              scm: scmContext(steps, async () => {
                const members = await scmFor(run, signal);
                if (run.execution?.source !== 'onboarding' && !legacyPreflight)
                  await runPreflight(steps, {
                    scope: 'scm',
                    members,
                    signal,
                    refreshMcp: async () => [],
                  });
                return createScm(steps, {
                  runId: run.runId,
                  lead: run.repo,
                  members,
                  signal,
                  approvals,
                  ...(run.execution?.reviewReports
                    ? {
                        validateWork: async (repo: string) => {
                          await revisionFor(repo);
                        },
                        onReady,
                      }
                    : {}),
                  onRefusal: async ({ key, refusal }) =>
                    mirrorFor(run).post(
                      key,
                      `${refusal.message}\n\n${refusal.fix}`,
                    ),
                });
              }),
            }
          : {}),
        agent: runAgent,
      };
    },
    beforeTerminal: async (run, result) => {
      if (
        !servicesEnabled ||
        !run.linear ||
        run.execution?.source === 'onboarding'
      )
        return;
      const outcome =
        result.status === 'failed'
          ? {
              kind: 'failed' as const,
              stepId: 'Run',
              reason: result.error.message,
            }
          : result.outcome === 'rejected'
            ? { kind: 'rejected' as const }
            : result.outcome === 'exhausted'
              ? { kind: 'giveUp' as const }
              : { kind: 'completed' as const };
      const journal = await readJournal(options.paths.run(run.runId).journal);
      const summaries = journal.entries
        .map((entry) => {
          const result = entry.result;
          if (
            result &&
            typeof result === 'object' &&
            !Array.isArray(result) &&
            typeof (result as { summary?: unknown }).summary === 'string'
          )
            return (result as { summary: string }).summary;
          return undefined;
        })
        .filter((summary): summary is string => Boolean(summary));
      await mirrorFor(run).finish(outcome, {
        changedSummary:
          summaries.at(-1) ??
          (result.status === 'failed'
            ? result.error.message
            : `Rocky Run ${result.status}.`),
      });
    },
  });
}
