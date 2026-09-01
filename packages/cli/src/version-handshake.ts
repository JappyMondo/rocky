/**
 * AC3: the CLI and the daemon exchange versions on every API call, and a
 * mismatch prints an upgrade hint. Nothing auto-restarts — the developer's
 * daemon may be mid-Run, and killing it is theirs to decide (NG-578).
 */

/**
 * The hint, or `null` when the two agree. Returning the string rather than
 * printing it is what lets every call site route it (stderr, the web UI
 * banner) without the check itself knowing where it lands.
 */
export function versionMismatchHint(
  daemonVersion: string,
  cliVersion: string,
): string | null {
  if (daemonVersion === cliVersion) {
    return null;
  }

  return `daemon is v${daemonVersion}, you're v${cliVersion} — \`rocky restart\` to upgrade`;
}
