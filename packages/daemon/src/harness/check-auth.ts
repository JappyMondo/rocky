/**
 * "Is this Harness signed in, as the account Rocky will actually use?" — the
 * `checkAuth` pre-flight NG-579 settled, as much of it as `rocky doctor` needs.
 *
 * ⚠️ **A seam, not the adapter interface.** NG-525 owns the Harness adapter,
 * where `checkAuth` belongs; it was still unwritten when NG-595 needed it, so
 * this exists to be absorbed rather than to stand. NG-628 tracks that. What
 * has to survive the move is NG-579's two commitments:
 *
 * - the probe runs under the harness's *configured* command and env, so a
 *   machine pointed at a second account is checked as that account;
 * - a missing login names the exact fix rather than reporting a bare false.
 *
 * The probes are each harness's own auth command — cheap, offline, and no
 * model call, because a check that costs tokens is one nobody runs.
 */
import { execFile } from 'node:child_process';

import { expandHarness } from '../config/expand.js';
import { ConfigError, type HarnessConfig } from '../config/schema.js';
import { SHIPPED_HARNESSES } from '../config/schema.js';

export type ShippedHarness = (typeof SHIPPED_HARNESSES)[number];

export interface AuthProbe {
  /** The binary, unless the instance config pins another. */
  command: string;
  /** The harness's own "am I signed in" question. */
  args: string[];
  /** What the developer types to fix a missing login. */
  fix: string;
  /** Reads the probe's own answer. */
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
  /** What was found, in a form worth printing under the check. */
  detail: string;
  /** The command to type. Absent when there is nothing a login would fix. */
  fix?: string;
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
} {
  try {
    const parsed = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      email?: string;
      authMethod?: string;
    };
    if (typeof parsed.loggedIn === 'boolean') {
      const who = [parsed.email, parsed.authMethod]
        .filter(Boolean)
        .join(' via ');
      return {
        signedIn: parsed.loggedIn,
        detail: parsed.loggedIn
          ? `signed in${who ? ` as ${who}` : ''}`
          : 'not signed in',
      };
    }
  } catch {
    // Fall through: an answer we cannot parse is read from the exit code,
    // which is the honest degradation rather than a guess at the text.
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
        // A non-zero exit is an answer, not a failure: "not signed in" is
        // exactly what some of these CLIs use it to say.
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

export async function checkHarnessAuth(
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

  const { signedIn, detail } = probe.readAnswer(result);

  return {
    harness,
    ok: signedIn,
    detail,
    ...(signedIn ? {} : { fix: probe.fix }),
  };
}
