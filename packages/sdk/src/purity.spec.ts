/**
 * AC2: `@rocky/sdk` contains no runtime behaviour.
 *
 * ADR 0003 makes this load-bearing rather than stylistic — the platform's
 * no-opt-out principle ("deleting the code that does a thing is how you stop it
 * happening") collapses if a library can ship behaviour behind a repo's back.
 * So this is a guard, not a smoke test: it fails when someone adds a runtime
 * export, a dependency, or an import that could touch the world.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import * as sdk from './index.js';

const SRC = import.meta.dirname;
const PKG = JSON.parse(
  readFileSync(join(SRC, '..', 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> };

/** Everything the package may export at runtime. Types are erased and free. */
const ALLOWED_RUNTIME_EXPORTS = ['linear', 'manual', 'z'];

/** The one runtime dependency: the schema library the SDK re-exports. */
const ALLOWED_DEPENDENCIES = ['zod'];

function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(SRC, f));
}

describe('the runtime surface', () => {
  it('exports only the Trigger builders and z', () => {
    expect(Object.keys(sdk).sort()).toEqual(ALLOWED_RUNTIME_EXPORTS);
  });

  it('exposes exactly one Linear event source', () => {
    expect(Object.keys(sdk.linear)).toEqual(['onDelegate']);
  });

  it('declares no dependency beyond the schema library', () => {
    expect(Object.keys(PKG.dependencies ?? {})).toEqual(ALLOWED_DEPENDENCIES);
  });
});

describe('the Trigger builders', () => {
  it('never run the Workflow they are handed', () => {
    const workflow = vi.fn();

    sdk.linear.onDelegate(workflow);
    sdk.manual('address-pr-conversations', workflow);

    expect(workflow).not.toHaveBeenCalled();
  });

  it('return frozen descriptors carrying the Workflow untouched', () => {
    const workflow = async () => 'merged' as const;

    const onDelegate = sdk.linear.onDelegate(workflow);
    expect(onDelegate).toEqual({ kind: 'linear.onDelegate', workflow });
    expect(Object.isFrozen(onDelegate)).toBe(true);

    const fired = sdk.manual('address-pr-conversations', workflow);
    expect(fired).toEqual({
      kind: 'manual',
      name: 'address-pr-conversations',
      workflow,
    });
    expect(Object.isFrozen(fired)).toBe(true);
  });
});

describe('the source', () => {
  it('imports nothing at runtime but the schema library', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');

      // `import type`/`export type` are erased at build time, so only value
      // from-clauses and any require() can reach a runtime module.
      const valueSpecifiers = [
        ...source.matchAll(
          /^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms,
        ),
      ]
        .map((m) => m[1])
        .filter((spec) => !spec.startsWith('.'));
      const requires = [...source.matchAll(/\brequire\s*\(\s*'([^']+)'/g)].map(
        (m) => m[1],
      );

      for (const spec of [...valueSpecifiers, ...requires]) {
        if (!ALLOWED_DEPENDENCIES.includes(spec)) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
