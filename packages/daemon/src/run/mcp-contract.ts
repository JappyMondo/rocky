import type { RockyPaths } from '../config/paths.js';
import {
  expandMcpConfig,
  readMcpConfig,
  resolveMcpServers,
  type McpServer,
} from '../mcp/index.js';

/** The exact server shape passed from NG-599 to a Harness invocation. */
export type ResolvedMcpServer = McpServer;

export interface McpRuntime {
  readMcpConfig(file: string): Promise<unknown>;
  expandMcpConfig(
    declarations: unknown,
    options: {
      env: NodeJS.ProcessEnv;
      run: { runDir: string; screenshotDir: string; port: number };
    },
  ): unknown;
  resolveMcpServers(
    config: unknown,
    names: readonly string[],
    options: { paths: RockyPaths; signal: AbortSignal },
  ): Promise<ResolvedMcpServer[]>;
}

export async function loadMcpRuntime(): Promise<McpRuntime> {
  // NG-599 is on main. Keep this narrow structural boundary only so snapshot
  // tests can supply a declaration parser without starting OAuth machinery.
  return {
    readMcpConfig,
    expandMcpConfig: (declarations, options) =>
      expandMcpConfig(
        declarations as Parameters<typeof expandMcpConfig>[0],
        options,
      ),
    resolveMcpServers: (config, names, options) =>
      resolveMcpServers(
        config as Parameters<typeof resolveMcpServers>[0],
        names,
        options,
      ),
  };
}
