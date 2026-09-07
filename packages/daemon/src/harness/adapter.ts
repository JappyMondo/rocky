import { execFile } from 'node:child_process';

import { expandHarness } from '../config/expand.js';
import {
  ConfigError,
  type HarnessConfig,
  SHIPPED_HARNESSES,
} from '../config/schema.js';

export type ShippedHarness = (typeof SHIPPED_HARNESSES)[number];

export interface AuthProbe {
  command: string;
  args: string[];
  fix: string;
  readAnswer(result: ProbeResult): { signedIn: boolean; detail: string };
}

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProbeRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ProbeResult>;

export interface HarnessAuthResult {
  harness: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface CheckAuthOptions {
  run?: ProbeRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** A Harness's daemon-facing behavior. */
export interface HarnessAdapter {
  name: ShippedHarness;
  checkAuth(
    config: HarnessConfig,
    options?: CheckAuthOptions,
  ): Promise<HarnessAuthResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function exitCodeAnswer(result: ProbeResult): {
  signedIn: boolean;
  detail: string;
} {
  const said = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
  return {
    signedIn: result.code === 0,
    detail:
      result.code === 0 ? 'signed in' : said || `exited ${String(result.code)}`,
  };
}

function readClaudeAnswer(result: ProbeResult): {
  signedIn: boolean;
  detail: string;
} {
  try {
    const parsed = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      email?: string;
      authMethod?: string;
    };
    if (typeof parsed.loggedIn === 'boolean') {
      const who = [parsed.email, parsed.authMethod].filter(Boolean).join(' via ');
      return {
        signedIn: parsed.loggedIn,
        detail: parsed.loggedIn
          ? `signed in${who ? ` as ${who}` : ''}`
          : 'not signed in',
      };
    }
  } catch {
    // Fall through to the harness's exit code when its output is unparseable.
  }

  return exitCodeAnswer(result);
}

function readOpencodeAnswer(result: ProbeResult): {
  signedIn: boolean;
  detail: string;
} {
  if (result.code !== 0) {
    return exitCodeAnswer(result);
  }

  const counted = /(\d+)\s+credential/.exec(result.stdout);
  if (counted) {
    const count = Number(counted[1]);
    return {
      signedIn: count > 0,
      detail:
        count > 0
          ? `${String(count)} credential${count === 1 ? '' : 's'} configured`
          : 'no credentials configured',
    };
  }

  return exitCodeAnswer(result);
}

export const AUTH_PROBES: Record<ShippedHarness, AuthProbe> = {
  'claude-code': {
    command: 'claude',
    args: ['auth', 'status'],
    fix: 'claude login',
    readAnswer: readClaudeAnswer,
  },
  opencode: {
    command: 'opencode',
    args: ['auth', 'list'],
    fix: 'opencode auth login',
    readAnswer: readOpencodeAnswer,
  },
};

export function harnessAuthEnv(
  harness: HarnessConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, ...harness.env };
}

const runWithExecFile: ProbeRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: options.env, timeout: options.timeoutMs },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error);
          return;
        }
        resolve({
          code: error?.code === undefined ? 0 : Number(error.code),
          stdout,
          stderr,
        });
      },
    );
  });

export function isShippedHarness(name: string): name is ShippedHarness {
  return (SHIPPED_HARNESSES as readonly string[]).includes(name);
}

async function checkAuth(
  harness: ShippedHarness,
  config: HarnessConfig,
  options: CheckAuthOptions = {},
): Promise<HarnessAuthResult> {
  const probe = AUTH_PROBES[harness];
  const run = options.run ?? runWithExecFile;
  const env = options.env ?? process.env;

  let resolved: HarnessConfig;
  try {
    resolved = expandHarness(harness, config, env);
  } catch (error) {
    return {
      harness,
      ok: false,
      detail: error instanceof ConfigError ? error.message : String(error),
    };
  }

  const command = resolved.command ?? probe.command;

  let result: ProbeResult;
  try {
    result = await run(command, probe.args, {
      env: harnessAuthEnv(resolved, env),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        harness,
        ok: false,
        detail: `\`${command}\` is not on PATH`,
        fix: `install ${harness}, or point config.json's harnesses.${harness}.command at it`,
      };
    }
    return { harness, ok: false, detail: String(error) };
  }

  const { signedIn, detail } = probe.readAnswer(result);
  return {
    harness,
    ok: signedIn,
    detail,
    ...(signedIn ? {} : { fix: probe.fix }),
  };
}

function adapter(name: ShippedHarness): HarnessAdapter {
  return {
    name,
    checkAuth: (config, options) => checkAuth(name, config, options),
  };
}

/** Every Harness implementation bundled with Rocky. */
export const SHIPPED_ADAPTERS: Record<ShippedHarness, HarnessAdapter> = {
  'claude-code': adapter('claude-code'),
  opencode: adapter('opencode'),
};

/** Looks up the adapter that owns a configured Harness. */
export function getHarnessAdapter(name: string): HarnessAdapter | undefined {
  return Object.hasOwn(SHIPPED_ADAPTERS, name)
    ? SHIPPED_ADAPTERS[name as ShippedHarness]
    : undefined;
}
