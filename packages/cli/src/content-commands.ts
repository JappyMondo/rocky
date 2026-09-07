import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AUTH_PROBES,
  expandHarness,
  harnessAuthEnv,
  readInstanceConfig,
  rockyPaths,
  type RockyPaths,
  type ShippedHarness,
} from '@rocky/daemon';

export interface InteractiveRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: 'inherit';
}
export interface InteractiveExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export async function initContent(options: {
  repo: string;
  /** Foreground framework inspection plus seedContent; never a Run. */
  seed(repo: string): Promise<string>;
}): Promise<string> {
  const repo = resolve(options.repo);
  if (await exists(join(repo, '.rocky'))) {
    throw new Error(
      'Already configured; delete .rocky/ first for a fresh seed.',
    );
  }
  return options.seed(repo);
}

export interface UpgradeOptions {
  repo: string;
  /** Installed package assets, supplied read-only by packaging. */
  shippedDir: string;
  harness?: ShippedHarness;
  interactive?: boolean;
  paths?: RockyPaths;
  env?: NodeJS.ProcessEnv;
  resolveHarness?(
    harness: ShippedHarness,
  ): Promise<{ command: string; env: NodeJS.ProcessEnv }>;
  launch?(request: InteractiveRequest): Promise<InteractiveExit>;
}

export async function upgradeContent(
  options: UpgradeOptions,
): Promise<InteractiveExit> {
  const harness = options.harness ?? 'claude-code';
  if (harness !== 'claude-code' && harness !== 'opencode') {
    throw new Error('Use --harness claude-code or --harness opencode.');
  }
  if (!(options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error(
      'rocky upgrade requires an interactive terminal. Run it directly in your terminal.',
    );
  }
  const repo = resolve(options.repo);
  const local = join(repo, '.rocky');
  if (!(await exists(local))?.isDirectory())
    throw new Error('No local .rocky/ directory. Run rocky init first.');
  const shipped = resolve(options.shippedDir);
  if (
    !(await exists(shipped))?.isDirectory() ||
    !(await exists(join(shipped, 'workflow.ts')))?.isFile()
  ) {
    throw new Error(
      'Shipped .rocky/ assets are missing: packaging failure. Reinstall the Rocky package.',
    );
  }
  const resolved = options.resolveHarness
    ? await options.resolveHarness(harness)
    : await resolveInteractiveHarness(
        harness,
        options.paths ?? rockyPaths(),
        options.env ?? process.env,
      );
  const prompt = `Compare the locally edited Workflow tree at ${JSON.stringify(local)} with the read-only shipped default at ${JSON.stringify(shipped)}. Read and discuss differences file by file, showing what to take and what to keep. Preserve local Config values and custom edits. Ask the human to approve each proposed change before applying it through native edit confirmation. Keep the shipped tree untouched. Leave accepted edits uncommitted. Never stage, commit, push, reset, roll back, or write version metadata. If the human aborts before approving edits, leave the working copy and index byte-identical; if they abort later, retain accepted edits. This is a conversation, not an automatic merge.`;
  const env = { ...resolved.env };
  let args: string[];
  if (harness === 'claude-code') {
    args = [
      '--permission-mode',
      'default',
      '--tools',
      'Read,Glob,Grep,Edit,Write',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--settings',
      JSON.stringify({
        disableAllHooks: true,
        permissions: {
          ask: ['Edit', 'Write', 'Bash', 'NotebookEdit', 'mcp__*'],
          deny: [`Edit(/${shipped}/**)`, `Write(/${shipped}/**)`],
        },
      }),
      prompt,
    ];
  } else {
    const permission = {
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      question: 'allow',
      edit: { '*': 'ask', [`${shipped}/**`]: 'deny' },
      bash: 'deny',
      task: 'deny',
    };
    const inherited = env.OPENCODE_CONFIG_CONTENT
      ? JSON.parse(env.OPENCODE_CONFIG_CONTENT)
      : {};
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...inherited,
      agent: {
        ...inherited.agent,
        'rocky-upgrade': {
          description: 'Negotiate Workflow changes with the human',
          mode: 'primary',
          permission,
        },
      },
    });
    env.OPENCODE_PERMISSION = JSON.stringify(permission);
    // Project config discovery can itself write .opencode files before the first turn.
    env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    args = ['--pure', '--agent', 'rocky-upgrade', '--prompt', prompt];
  }
  try {
    return await (options.launch ?? launchInteractive)({
      command: resolved.command,
      args,
      cwd: repo,
      env,
      stdio: 'inherit',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Cannot launch ${harness}: install ${resolved.command} or fix harnesses.${harness}.command, then sign in with its native login command.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function resolveInteractiveHarness(
  harness: ShippedHarness,
  paths: RockyPaths,
  env: NodeJS.ProcessEnv,
) {
  const config = await readInstanceConfig(paths);
  const resolved = expandHarness(harness, config.harnesses[harness] ?? {}, env);
  return {
    command: resolved.command ?? AUTH_PROBES[harness].command,
    env: harnessAuthEnv(resolved, env),
  };
}

export function launchInteractive(
  request: InteractiveRequest,
): Promise<InteractiveExit> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: request.stdio,
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    });
  });
}

async function exists(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}
