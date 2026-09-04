/**
 * `${VAR}` expansion in the `harnesses` block (NG-579).
 *
 * The point is that a raw key never has to be written into `config.json` —
 * which matters because `config.json` is the file that holds no secrets and is
 * safe to hand-edit and to show in the web UI.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './schema.js';
import { expandHarness, expandVars } from './expand.js';

describe('expanding one value', () => {
  const env = { HOME: '/home/dev', TOKEN: 'sk-123' };

  it('substitutes a variable', () => {
    expect(expandVars('${HOME}/.claude', env)).toBe('/home/dev/.claude');
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(expandVars('${HOME}:${HOME}', env)).toBe('/home/dev:/home/dev');
  });

  it('leaves a value with no variables alone', () => {
    expect(expandVars('/opt/claude/claude', env)).toBe('/opt/claude/claude');
  });

  it('leaves a bare $ or an unclosed brace alone rather than guessing', () => {
    expect(expandVars('cost: $5', env)).toBe('cost: $5');
    expect(expandVars('${HOME', env)).toBe('${HOME');
  });

  it('fails loudly on a variable that is not set, naming it', () => {
    // Silently expanding to "" would point a harness at the wrong account and
    // look like a login problem an hour later.
    expect(() => expandVars('${NOPE}/x', env)).toThrow(ConfigError);
    expect(() => expandVars('${NOPE}/x', env)).toThrow(/NOPE/);
  });

  it('names every missing variable at once, not just the first', () => {
    expect(() => expandVars('${A}${B}', env)).toThrow(/A.*B/s);
  });

  it('treats a variable set to the empty string as set', () => {
    expect(expandVars('[${EMPTY}]', { EMPTY: '' })).toBe('[]');
  });
});

describe('expanding a harness block', () => {
  it('expands the command and every env value', () => {
    const resolved = expandHarness(
      'opencode',
      {
        command: '${TOOLS}/opencode',
        env: { OPENCODE_CONFIG_DIR: '${ROCKY_WORK_OPENCODE}', PLAIN: 'kept' },
      },
      { TOOLS: '/opt', ROCKY_WORK_OPENCODE: '/home/dev/.opencode-work' },
    );

    expect(resolved).toEqual({
      command: '/opt/opencode',
      env: {
        OPENCODE_CONFIG_DIR: '/home/dev/.opencode-work',
        PLAIN: 'kept',
      },
    });
  });

  it('names the harness in the error, so the fix is obvious', () => {
    expect(() =>
      expandHarness('opencode', { env: { X: '${NOPE}' } }, {}),
    ).toThrow(/opencode/);
  });

  it('is happy with an empty block', () => {
    expect(expandHarness('opencode', {}, {})).toEqual({});
  });
});
