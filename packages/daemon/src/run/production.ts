import { join } from 'node:path';

import { expandHarness } from '../config/expand.js';
import type { RockyPaths } from '../config/paths.js';
import { resolveRepoEnv } from '../config/routing.js';
import type { InstanceConfig } from '../config/schema.js';
import { readCredentials } from '../config/store.js';
import { createAgent, type AgentOptions } from './agent.js';
import { readJournal } from './journal.js';
import { loadSnapshotWorkflow } from './loading/loader.js';
import { loadMcpRuntime, type McpRuntime } from './mcp-contract.js';
import { WorkflowRuntime, type WorkflowRuntimeOptions } from './lifecycle.js';
import type { BootRequest } from './worker.js';

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
  let mcp: Promise<{ runtime: McpRuntime; config: unknown }> | undefined;
  return new WorkflowRuntime({
    paths: options.paths,
    read: readJournal,
    append: async (_path, entry, appendOptions) => {
      await options.request({ kind: 'append', entry, options: appendOptions });
    },
    loadWorkflow: async (run, signal) => {
      if (!run.execution || !run.linear)
        throw new Error(
          `${run.runId}: missing immutable execution/Linear identity; re-delegate through the production admission service`,
        );
      signal.throwIfAborted();
      const credentials = await readCredentials(options.paths);
      env = {
        ...process.env,
        ...resolveRepoEnv(options.config(), credentials, run.repo),
        ROCKY_RUN_DIR: options.paths.run(run.runId).dir,
        ROCKY_SCREENSHOT_DIR: options.paths.run(run.runId).screenshotsDir,
        ROCKY_PORT: String(run.ports[0] ?? ''),
      };
      mcp = undefined;
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
      await options.preflight?.(run, steps, signal);
    },
    env: () => env,
    external: (run, steps, signal) => {
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
      return {
        ...options.external?.(run, steps, signal),
        agent: createAgent(steps, {
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
          onEvent: options.onEvent,
          steer: options.steer,
        }),
      };
    },
  });
}
