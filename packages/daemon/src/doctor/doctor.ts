/**
 * `rocky doctor` (NG-595): config validation, an endpoint self-ping through
 * the configured `publicUrl`, and each Harness's `checkAuth`.
 *
 * Doctor is a *reporter*. It never repairs anything and never throws — a check
 * that blows up is a failed check with the explosion as its detail, because a
 * doctor that dies on the first problem cannot tell you about the second.
 *
 * Scope, settled in NG-595's pre-flight:
 * - the recurring boot-and-hourly ping and its `rocky status` banner are
 *   NG-600's; this is the one-shot on-demand ping only;
 * - the harness probe is NG-595's interim seam, absorbed by NG-525 (NG-628).
 */
import {
  checkHarnessAuth,
  isShippedHarness,
  type HarnessAuthResult,
} from '../harness/check-auth.js';
import type { RockyPaths } from '../config/paths.js';
import { SHIPPED_HARNESSES, type HarnessConfig } from '../config/schema.js';
import { readInstanceConfig } from '../config/store.js';
import { readPingIdentity } from '../endpoint/ping.js';
import { inspectPidFile } from '../lifecycle/pidfile.js';

export interface DoctorCheck {
  /** Short and stable — the CLI prints it as the check's label. */
  name: string;
  ok: boolean;
  /** What was found. One line, worth printing under the name. */
  detail: string;
  /** What to do about it. Present only when there is something to do. */
  fix?: string;
  /** Nothing to check, and nothing wrong. Never counts against the run. */
  skipped?: boolean;
  /**
   * Reported, but not counted against the exit code. Which Harness a Run uses
   * is content (NG-579), so a shipped harness this machine never configured is
   * worth mentioning and wrong to fail on.
   */
  advisory?: boolean;
}

export type DoctorReport = DoctorCheck[];

export interface DoctorOptions {
  fetch?: typeof fetch;
  /** Injected by the tests; production runs the harness's own auth command. */
  checkHarness?(
    harness: string,
    config: HarnessConfig,
  ): Promise<HarnessAuthResult>;
  /** A dead endpoint should not hold the terminal for a minute. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The exit code's only input: advisory and skipped checks never count. */
export function anyFailed(report: DoctorReport): boolean {
  return report.some((check) => !check.ok && !check.advisory && !check.skipped);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pingEndpoint(
  publicUrl: string,
  paths: RockyPaths,
  configuredPort: number,
  options: DoctorOptions,
): Promise<DoctorCheck> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let localIdentity: string;
  try {
    const pid = await inspectPidFile(paths);
    const port = pid.state === 'running' ? pid.record.port : configuredPort;
    localIdentity = await readPingIdentity(
      `http://127.0.0.1:${port}`,
      doFetch,
      timeoutMs,
    );
  } catch {
    return {
      name: 'publicUrl',
      ok: false,
      detail: 'cannot establish the running local daemon instance identity',
      fix: 'run `rocky start` with a loopback listener and check its port; then rerun `rocky doctor` (docs/public-endpoint.md)',
    };
  }

  try {
    const publicIdentity = await readPingIdentity(
      publicUrl,
      doFetch,
      timeoutMs,
    );
    if (publicIdentity !== localIdentity) {
      throw new Error('reached another daemon, not the running local instance');
    }
    return {
      name: 'publicUrl',
      ok: true,
      detail: 'public /api/ping matches the running local daemon instance',
    };
  } catch (error) {
    return {
      name: 'publicUrl',
      ok: false,
      detail: `public /api/ping ${messageOf(error)}`,
      fix: "point the tunnel at this daemon's webhook/ping-only filter; check `rocky-ingress` and publicUrl using docs/public-endpoint.md, then rerun `rocky doctor`",
    };
  }
}

/**
 * Every check, in the order a human wants to read them: the config first,
 * because a config that will not parse makes the rest unknowable.
 */
export async function runDoctor(
  paths: RockyPaths,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const report: DoctorReport = [];

  let config;
  try {
    config = await readInstanceConfig(paths);
    report.push({
      name: 'config.json',
      ok: true,
      detail: `${paths.configFile} parses; ${String(config.repos.length)} repo${config.repos.length === 1 ? '' : 's'}, ${String(config.groups.length)} group${config.groups.length === 1 ? '' : 's'}`,
    });
  } catch (error) {
    report.push({
      name: 'config.json',
      ok: false,
      detail: messageOf(error),
      fix: `fix ${paths.configFile} — every other check reads it`,
    });
    // The harness blocks live in the config, so there is nothing left to check
    // under one that would not parse. The endpoint is in there too.
    return report;
  }

  report.push(
    config.publicUrl === undefined
      ? {
          name: 'publicUrl',
          ok: true,
          skipped: true,
          detail:
            'not set — Linear has nowhere to deliver webhooks yet. `rocky setup` asks for it first.',
        }
      : await pingEndpoint(
          config.publicUrl,
          paths,
          config.server.port,
          options,
        ),
  );

  const check =
    options.checkHarness ??
    ((harness: string, harnessConfig: HarnessConfig) =>
      isShippedHarness(harness)
        ? checkHarnessAuth(harness, harnessConfig)
        : Promise.resolve({
            harness,
            ok: false,
            detail: `Rocky ships no adapter for "${harness}"`,
          }));

  // Every shipped harness is reported, but only the ones this machine
  // configured are failed on — see `advisory` above.
  for (const harness of SHIPPED_HARNESSES) {
    const configured = config.harnesses[harness];

    let result: HarnessAuthResult;
    try {
      result = await check(harness, configured ?? {});
    } catch (error) {
      result = { harness, ok: false, detail: messageOf(error) };
    }

    report.push({
      name: `harness ${harness}`,
      ok: result.ok,
      detail: result.detail,
      ...(result.fix === undefined ? {} : { fix: result.fix }),
      ...(configured === undefined && !result.ok ? { advisory: true } : {}),
    });
  }

  return report;
}
