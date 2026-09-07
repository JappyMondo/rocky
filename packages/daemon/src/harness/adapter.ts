/** Adapter-owned auth, adopted from NG-628's stable 2026-09-07 snapshot. */
import { stripVTControlCharacters } from 'node:util';

import { expandHarness } from '../config/expand.js';
import { ConfigError, type HarnessConfigInput } from '../config/schema.js';
import { SHIPPED_HARNESSES } from '../config/schema.js';
import { claudeCode, claudeExecutionEnv } from './claude-code.js';
import { opencode } from './opencode.js';
import type { HarnessInvocation, HarnessResult } from './types.js';
import { runProcess } from './process.js';

export interface HarnessAdapter {
  readonly name: ShippedHarness;
  run(input: HarnessInvocation): Promise<HarnessResult>;
  resume(
    input: HarnessInvocation & { sessionId: string },
  ): Promise<HarnessResult>;
  checkAuth(
    config: HarnessConfigInput,
    options?: CheckAuthOptions,
  ): Promise<HarnessAuthResult>;
}

export type ShippedHarness = (typeof SHIPPED_HARNESSES)[number];

export interface AuthProbe {
  /** The binary, unless the instance config pins another. */
  command: string;
  /** The harness's own "am I signed in" question. */
  args: string[];
  /** What the developer types to fix a missing login. */
  fix: string;
  /** Reads the probe's own answer. */
  readAnswer(result: ProbeResult): { signedIn: boolean; detail: string; identity?: HarnessAuthIdentity };
}

export interface HarnessAuthIdentity {
  accountId?: string;
  email?: string;
  organizationId?: string;
  authMethod?: string;
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
  /** What was found, in a form worth printing under the check. */
  detail: string;
  /** The command to type. Absent when there is nothing a login would fix. */
  fix?: string;
  /** Identity reported by the execution probe, never inferred from the host probe. */
  identity?: HarnessAuthIdentity;
}

export interface CheckAuthOptions {
  run?: ProbeRunner;
  /** The daemon's own environment, which the configured env layers over. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** A probe that hangs must not hang `rocky doctor` with it. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `claude auth status` prints JSON with a `loggedIn` flag and, when signed in,
 * the account — which is exactly the thing worth showing back, since the whole
 * point of the configured env is that it may not be the obvious account.
 */
function readClaudeAnswer(result: ProbeResult): {
  signedIn: boolean;
  detail: string;
  identity?: HarnessAuthIdentity;
} {
  try {
    const parsed = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      email?: string;
      authMethod?: string;
      accountId?: string;
      orgId?: string;
      organizationId?: string;
    };
    if (typeof parsed.loggedIn === 'boolean') {
      const signedIn = parsed.loggedIn && result.code === 0;
      const identity: HarnessAuthIdentity = Object.fromEntries(Object.entries({ email: parsed.email, accountId: parsed.accountId, organizationId: parsed.orgId ?? parsed.organizationId, authMethod: parsed.authMethod }).filter(([, value]) => typeof value === 'string' && value.length > 0));
      const who = [identity.email ?? identity.accountId, identity.authMethod]
        .filter(Boolean)
        .join(' via ');
      return {
        signedIn,
        identity,
        detail: signedIn
          ? `signed in${who ? ` as ${who}` : ''}${identity.email || identity.accountId ? '' : ' (account identity not reported)'}`
          : parsed.loggedIn
            ? `authentication probe exited ${result.code}`
            : 'not signed in',
      };
    }
  } catch {
    // Unrecognized output must never become a positive auth answer.
  }

  return exitCodeAnswer(result);
}

/**
 * `opencode auth list` ends with a count of the credentials it holds. Zero
 * credentials is a CLI that will fail at the first Agent call.
 */
function readOpencodeAnswer(result: ProbeResult): {
  signedIn: boolean;
  detail: string;
} {
  if (result.code !== 0) {
    return exitCodeAnswer(result);
  }

  const stdout = stripVTControlCharacters(result.stdout);
  const environment = /(\d+)\s+environment variable/.exec(stdout);
  if (environment && Number(environment[1]) > 0)
    return {
      signedIn: true,
      detail: `${environment[1]} environment variable(s) configured`,
    };
  const counted = /(\d+)\s+credential/.exec(stdout);
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

function exitCodeAnswer(result: ProbeResult): {
  signedIn: boolean;
  detail: string;
} {
  const said = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
  return {
    signedIn: false,
    detail:
      result.code === 0
        ? 'unrecognized authentication status'
        : said || `exited ${String(result.code)}`,
  };
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

/**
 * The daemon's environment with the harness block's own layered over it —
 * NG-579's "signed in as the account Rocky will actually use".
 */
export function harnessAuthEnv(
  harness: HarnessConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, ...harness.env };
}

const runWithExecFile: ProbeRunner = async (command, args, options) => {
  const result = await runProcess({ command, args, ...options });
  return { ...result, code: result.code ?? -1 };
};

export function isShippedHarness(name: string): name is ShippedHarness {
  return (SHIPPED_HARNESSES as readonly string[]).includes(name);
}

async function checkAuth(
  harness: ShippedHarness,
  config: HarnessConfigInput,
  options: CheckAuthOptions = {},
): Promise<HarnessAuthResult> {
  const probe = AUTH_PROBES[harness];
  const run = options.run ?? runWithExecFile;
  const env = options.env ?? process.env;

  let resolved: HarnessConfigInput;
  try {
    resolved = expandHarness(harness, config, env);
  } catch (error) {
    // An unset `${VAR}` fails this check rather than the daemon: doctor's job
    // is to report what is wrong, not to become the next thing that is.
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
      // A missing binary and a missing login are two problems with two fixes;
      // sending the developer to `claude login` when there is no `claude` just
      // makes them watch a second command fail.
      return {
        harness,
        ok: false,
        detail: `\`${command}\` is not on PATH`,
        fix: `install ${harness}, or point config.json's harnesses.${harness}.command at it`,
      };
    }
    return { harness, ok: false, detail: String(error) };
  }

  let answer = probe.readAnswer(result);

  if (answer.signedIn && harness === 'claude-code') {
    try {
      const isolated = await run(command, ['--setting-sources', '', ...probe.args], {
        env: claudeExecutionEnv(harnessAuthEnv(resolved, env)),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const execution = probe.readAnswer(isolated);
      if (!execution.signedIn)
        return {
          harness,
          ok: false,
          identity: execution.identity,
          detail: `Claude authentication is unavailable under execution settings: ${execution.detail}`,
          fix: 'claude login',
        };
      const mismatch = (['accountId', 'email', 'organizationId'] as const).some((key) => answer.identity?.[key] !== undefined && answer.identity[key] !== execution.identity?.[key]);
      if (mismatch) return { harness, ok: false, identity: execution.identity, detail: `Execution identity does not match the configured Claude account: ${execution.detail}; check harnesses.claude-code.command/env`, fix: 'claude login' };
      answer = execution;
    } catch {
      return {
        harness,
        ok: false,
        detail: 'could not verify execution Claude authentication',
        fix: probe.fix,
      };
    }
  }

  return {
    harness,
    ok: answer.signedIn,
    ...(answer.identity ? { identity: answer.identity } : {}),
    detail: answer.signedIn
      ? `${answer.detail}; model access not verified by this offline probe`
      : answer.detail,
    ...(answer.signedIn ? {} : { fix: probe.fix }),
  };
}

export const SHIPPED_ADAPTERS: Record<ShippedHarness, HarnessAdapter> = {
  'claude-code': {
    ...claudeCode,
    name: 'claude-code',
    checkAuth: (config, options) => checkAuth('claude-code', config, options),
  },
  opencode: {
    ...opencode,
    name: 'opencode',
    checkAuth: (config, options) => checkAuth('opencode', config, options),
  },
};

export function getHarnessAdapter(name: string): HarnessAdapter | undefined {
  return Object.hasOwn(SHIPPED_ADAPTERS, name)
    ? SHIPPED_ADAPTERS[name as ShippedHarness]
    : undefined;
}
