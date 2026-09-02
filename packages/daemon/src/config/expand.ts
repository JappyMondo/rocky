/**
 * `${VAR}` expansion for the `harnesses` block (NG-579), the same shape
 * `.rocky/mcp.json` uses. It keeps raw keys out of `config.json`, which is the
 * file that holds no secrets.
 */
import { ConfigError, type HarnessConfig } from './schema.js';

/** `${NAME}` — shell-ish, but deliberately without defaults or `$BARE`. */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type Env = Record<string, string | undefined>;

/**
 * Substitutes every `${VAR}`. A variable that is not set throws rather than
 * expanding to the empty string: an empty `CLAUDE_CONFIG_DIR` silently points
 * the harness at the wrong account, and surfaces an hour later as a login
 * failure with no trace of the cause.
 */
export function expandVars(
  value: string,
  env: Env = process.env,
  where = 'config.json',
): string {
  const missing: string[] = [];

  const expanded = value.replace(VARIABLE, (_match, name: string) => {
    const found = env[name];
    if (found === undefined) {
      missing.push(name);
      return '';
    }
    return found;
  });

  if (missing.length > 0) {
    throw new ConfigError(
      where,
      `${JSON.stringify(value)} references ${missing.length === 1 ? 'a variable' : 'variables'} that ${missing.length === 1 ? 'is' : 'are'} not set: ${[...new Set(missing)].join(', ')}`,
    );
  }

  return expanded;
}

/**
 * A harness block with its `${VAR}`s resolved. Deliberately computed on
 * demand rather than at load: the expansion depends on the daemon's
 * environment, and a missing variable should name the harness that wanted it.
 */
export function expandHarness(
  name: string,
  harness: HarnessConfig,
  env: Env = process.env,
): HarnessConfig {
  const where = `config.json harnesses.${name}`;
  const resolved: HarnessConfig = { ...harness };

  if (harness.command !== undefined) {
    resolved.command = expandVars(harness.command, env, where);
  }

  if (harness.env !== undefined) {
    resolved.env = Object.fromEntries(
      Object.entries(harness.env).map(([key, value]) => [
        key,
        expandVars(value, env, `${where}.env.${key}`),
      ]),
    );
  }

  return resolved;
}
