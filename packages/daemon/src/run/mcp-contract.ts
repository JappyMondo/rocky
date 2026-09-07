import type { RockyPaths } from '../config/paths.js';

/** The NG-599 consumer contract, kept structural while this stacked lane lands. */
export interface ResolvedMcpServer {
  name: string;
  config: Record<string, unknown>;
}

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

/** The implementation is supplied by the stacked NG-599 dependency. */
export class McpRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpRuntimeUnavailableError';
  }
}

const mcpModule = ['..', 'mcp', 'index.js'].join('/');

export async function loadMcpRuntime(): Promise<McpRuntime> {
  let loaded: unknown;
  try {
    loaded = await import(mcpModule);
  } catch (error) {
    throw new McpRuntimeUnavailableError(
      `The NG-599 MCP runtime is unavailable: ${error instanceof Error ? error.message : String(error)}. Integrate its readMcpConfig, expandMcpConfig and resolveMcpServers contract before running this Workflow.`,
    );
  }
  if (
    !loaded ||
    typeof loaded !== 'object' ||
    typeof (loaded as Partial<McpRuntime>).readMcpConfig !== 'function' ||
    typeof (loaded as Partial<McpRuntime>).expandMcpConfig !== 'function' ||
    typeof (loaded as Partial<McpRuntime>).resolveMcpServers !== 'function'
  ) {
    throw new McpRuntimeUnavailableError(
      'The NG-599 MCP runtime does not expose readMcpConfig, expandMcpConfig and resolveMcpServers. Integrate the documented MCP contract before running this Workflow.',
    );
  }
  return loaded as McpRuntime;
}
