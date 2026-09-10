import type { ScmPr } from '@rocky/sdk';
import type { Answer } from '@rocky/local-contracts';
import type { StepOutcome } from './replay.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { LocalArtifacts } from '../local-api/artifacts.js';
import {
  generateReport,
  reportId,
  reportMarkdown,
} from '../review-report/reporter.js';
import { reviewRevision } from '../review-report/workspace.js';
import { fileURLToPath } from 'node:url';

import { expandHarness } from '../config/expand.js';
import type { RockyPaths } from '../config/paths.js';
import type { InstanceConfig } from '../config/schema.js';
import { readCredentials } from '../config/store.js';
import { LinearRunMirror } from '../linear/mirror.js';
import { RockyLinearClient } from '../linear/client.js';
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

/** Profile-owned environment: repository config cannot inject a Run variable. */
function profileEnv(
  run: {
    profile?: {
      settings: { env: Record<string, string>; secretEnv: string[] };
    };
    repo: string;
  },
  credentials: Awaited<ReturnType<typeof readCredentials>>,
): Record<string, string> {
  const profile = run.profile;
  if (!profile)
    throw new Error(
      `${run.repo}: missing local profile snapshot; re-delegate after assigning a profile.`,
    );
  const stored = credentials.repos[run.repo] ?? {};
  return {
    ...profile.settings.env,
    ...Object.fromEntries(
      profile.settings.secretEnv.flatMap((name) => {
        const value = stored[name] ?? process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
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
  let env: NodeJS.ProcessEnv = {};
  const registeredTranscripts = new Set<string>();
  let credentials: Awaited<ReturnType<typeof readCredentials>>;
  let activeRun:
    Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0] | undefined;
  // A direct Runtime construction is useful for isolated Workflow tests. A
  // real admitted Linear Run has an access token (hydration could not happen
  // otherwise), so only those Runs receive network-backed production services.
  let servicesEnabled = false;
  let mcp: Promise<{ runtime: McpRuntime; config: unknown }> | undefined;
  // A mirror has a small in-memory coalescing buffer. Keep one per Run rather
  // than constructing one per effect so streamed status is actually flushed.
  const mirrors = new Map<string, LinearRunMirror>();
  const mirrorFlushes = new Map<string, ReturnType<typeof setTimeout>>();
  const linearClient = new RockyLinearClient({
    auth: async () => (await readCredentials(options.paths)).linear ?? {},
    save: async () => undefined,
  });
  const mirrorFor = (
    run: Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0],
  ) => {
    if (!run.linear) throw new Error(`${run.runId}: missing Linear identity`);
    const existing = mirrors.get(run.runId);
    if (existing) return existing;
    const mirror = new LinearRunMirror({
      runId: run.runId,
      issueId: run.linear.issueId,
      sessionId: run.linear.sessionId,
      teamId: run.linear.teamId,
      localOrigin: `http://localhost:${options.config().server.port}`,
      platform: {
        terminalComments: 'one',
        elicitationComments: 'none',
        evidence: 'Linear Agent Session qualification recorded by Rocky.',
      },
      client: linearClient,
      store: {
        get: async (key) => options.request({ kind: 'control-get', key }),
        put: async (key, value) => {
          await options.request({ kind: 'control-put', key, value });
        },
      },
    });
    mirrors.set(run.runId, mirror);
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
  const scmFor = (
    run: Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0],
    signal: AbortSignal,
  ) => {
    if (!run.execution) throw new Error(`${run.runId}: missing frozen members`);
    return run.execution.members.map((member) => {
      const source = scmProject(member.url);
      const memberEnv = profileEnv(
        { profile: run.profile, repo: member.name },
        credentials,
      );
      const token =
        source.platform === 'github'
          ? (memberEnv.GITHUB_TOKEN ?? memberEnv.GH_TOKEN)
          : memberEnv.GITLAB_TOKEN;
      if (!token)
        throw new Error(
          `${member.name}: missing ${source.platform === 'github' ? 'GITHUB_TOKEN (or GH_TOKEN)' : 'GITLAB_TOKEN'} in this repository's secret environment.`,
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
    });
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
      credentials = await readCredentials(options.paths);
      // A browser-fired manual Run is deliberately not an Agent Session. It
      // still gets the normal local profile, workspace, and Harness, but it
      // must not create a mirror, invoke SCM preflight, or pretend it can post
      // Linear effects without a session-owned identity.
      servicesEnabled = Boolean(credentials.linear?.accessToken && run.linear);
      activeRun = run;
      env = {
        ...process.env,
        ...profileEnv(run, credentials),
        ROCKY_RUN_DIR: options.paths.run(run.runId).dir,
        ROCKY_LEAD_REPO: join(
          options.paths.run(run.runId).workspaceDir,
          run.execution.members.find((member) => member.lead)?.path ?? run.repo,
        ),
        ROCKY_SCREENSHOT_DIR: options.paths.run(run.runId).screenshotsDir,
        ROCKY_PORT: String(run.ports[0] ?? ''),
      };
      mcp = undefined;
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
            const { RockyLinearClient } = await import('../linear/client.js');
            const client = new RockyLinearClient({
              auth: async () =>
                (await readCredentials(options.paths)).linear ?? {},
              save: async () => undefined,
            });
            return client.workflowStates(linear.teamId);
          },
          validate: async (directory: string) => {
            await validateSnapshotTriggers(directory, { signal });
          },
        });
      }
      return loadSnapshotWorkflow(
        options.paths.run(run.runId).snapshotDir,
        run.execution.trigger,
      );
    },
    beforeWorkflow: async (run, steps, signal) => {
      await steps.step('workspace', {}, async () => ({
        status: 'done',
        result: await options.request({ kind: 'workspace' }),
      }));
      if (servicesEnabled) {
        // Onboarding is already an acknowledged Agent Session and reports its
        // seed PR through ctx.post.  Do not add a second comment before the
        // seed exists: Linear may have rendered historical session comments
        // that cannot safely be attributed by the strict two-comment gate.
        if (run.execution?.source !== 'onboarding') {
          const mirror = mirrorFor(run);
          await steps.step('linear.start', {}, async () => {
            await mirror.start();
            return { status: 'done' as const, result: null };
          });
        }
        // The seed Workflow deliberately leaves merging to the human. Its
        // branch does not exist until the Workflow pushes it, so the ordinary
        // merge/rebase preflight would reject onboarding before it can create
        // its non-draft PR. Its SCM operations still fail closed at the exact
        // push/PR/CI boundary if the configured token lacks authority.
        if (run.execution?.source !== 'onboarding') {
          const members = scmFor(run, signal);
          await runPreflight(steps, {
            members,
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
      const resolveHarness = (name: 'claude-code' | 'opencode') => {
        const settings = expandHarness(
          name,
          options.config().harnesses[name] ?? {},
          env,
        );
        return {
          command:
            settings.command ??
            (name === 'claude-code' ? 'claude' : 'opencode'),
          env: { ...env, ...settings.env },
          sessionStorage:
            settings.sessionStorage === 'opencode'
              ? ('opencode' as const)
              : ('rocky' as const),
        };
      };
      const runAgent = createAgent(steps, {
        snapshotDir: options.paths.run(run.runId).snapshotDir,
        cwd: options.paths.run(run.runId).workspaceDir,
        sessionDir: options.paths.run(run.runId).sessionsDir,
        harness: 'claude-code',
        harnesses: {
          get 'claude-code'() {
            return resolveHarness('claude-code');
          },
          get opencode() {
            return resolveHarness('opencode');
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
        );
      };
      const onReady = async (pr: ScmPr) => {
        const publishedKey = `review-report:${reportId(pr)}:published`;
        const revision = await steps.step(
          'reviewReport.revision',
          { label: 'Verify pushed PR changes' },
          async () => ({
            status: 'done',
            result: await revisionFor(pr.repo, pr.headSha),
          }),
        );
        const published = await steps.step(
          'reviewReport.published',
          { label: 'Check report publication' },
          async () => ({
            status: 'done',
            result:
              (await options.request({
                kind: 'control-get',
                key: publishedKey,
              })) === true,
          }),
        );
        if (published) return;
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
        const report = await generateReport({
          steps,
          agent: runAgent,
          artifacts,
          runId: run.runId,
          pr,
          ...revision,
          issue: run.issue,
          screenshotDir: options.paths.run(run.runId).screenshotsDir,
          workspace: run.execution?.members,
          workflow: run.profile?.workflow.source,
          scope,
          port: run.ports[0],
          agentOptions: {
            harness: run.profile?.grants.harness ?? 'opencode',
            tools: ['read', 'bash'],
            mcp: run.profile?.grants.mcp ?? [],
          },
        });
        const images: Record<string, string> = {};
        for (const shot of report.visuals.flatMap(
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
        const markdown = reportMarkdown(
          report,
          `http://localhost:${options.config().server.port}`,
          images,
        );
        await steps.step(
          'reviewReport.publish',
          { label: 'Post review report to Linear and PR' },
          async () => {
            // Re-check after a potentially long visual sweep: stale evidence must never mark another head ready.
            await revisionFor(pr.repo, pr.headSha);
            const adapter = scmFor(run, signal).find(
              (adapter) => adapter.repo.id === pr.repo,
            );
            if (!adapter) throw new Error(`Unknown SCM repository ${pr.repo}`);
            await adapter.postReviewReport(
              pr,
              markdown,
              `${run.runId}:${report.id}`,
            );
            await mirrorFor(run).comment(`report:${report.id}`, markdown);
            await options.request({
              kind: 'control-put',
              key: publishedKey,
              value: true,
            });
            return {
              status: 'done',
              result: { reportId: report.id, headSha: pr.headSha },
            };
          },
        );
      };
      return {
        ...options.external?.(run, steps, signal, approvals),
        ...(servicesEnabled
          ? {
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
              comment: (markdown: string) =>
                steps.step('linear.comment', {}, async () => {
                  await mirrorFor(run).comment(effectId(markdown), markdown);
                  return { status: 'done', result: undefined };
                }),
              post: async (markdown: string) =>
                mirrorFor(run).post(effectId(`post:${markdown}`), markdown),
              linear: {
                setState: async (name: string) =>
                  mirrorFor(run).setState(`state:${name}`, name),
              },
              scm: createScm(steps, {
                runId: run.runId,
                lead: run.repo,
                members: scmFor(run, signal),
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
