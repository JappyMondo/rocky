import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Workflow } from '@rocky/sdk';

export type TriggerSelector =
  { kind: 'linear.onDelegate' } | { kind: 'manual'; name: string };

export class WorkflowLoadError extends Error {
  readonly kind: 'invalid-workflow' | 'onboarding-required';
  readonly file: string;
  readonly fix: string;

  constructor(
    kind: 'invalid-workflow' | 'onboarding-required',
    file: string,
    error: string,
    fix: string,
  ) {
    super(`${file}: ${error}. ${fix}`);
    this.name = 'WorkflowLoadError';
    this.kind = kind;
    this.file = file;
    this.fix = fix;
  }
}

export function resolveSnapshotTrigger<T extends TriggerSelector>(
  triggers: readonly T[],
  selector: TriggerSelector,
): T {
  const selected = triggers.find(
    (trigger) =>
      trigger.kind === selector.kind &&
      (trigger.kind !== 'manual' ||
        (selector.kind === 'manual' && trigger.name === selector.name)),
  );
  if (selected) return selected;
  throw new WorkflowLoadError(
    'invalid-workflow',
    '.rocky/workflow.ts',
    selector.kind === 'manual'
      ? `no manual Trigger named ${JSON.stringify(selector.name)}`
      : 'no delegation Trigger',
    selector.kind === 'manual'
      ? 'Add that manual(name, workflow) binding or choose an existing manual Trigger.'
      : 'Add linear.onDelegate(workflow) to the default export or fire a manual Trigger.',
  );
}

/** Runner-owned child only; hooks remain active for lazy imports during the Boot. */
export async function importSnapshotTriggers(snapshotDir: string): Promise<
  {
    descriptor: TriggerSelector;
    workflow: Workflow;
  }[]
> {
  const file = join(snapshotDir, 'workflow.ts');
  try {
    const root = realpathSync(snapshotDir);
    const identity = randomUUID();
    const inside = (path: string) => {
      const rel = relative(root, path);
      return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
    };
    const scoped = (url: string | undefined) =>
      url?.startsWith('file:') &&
      new URL(url).searchParams.get('rockyBoot') === identity;
    const localUrl = (url: URL) => {
      let path = fileURLToPath(url);
      if (!inside(path))
        throw new Error(`import escapes snapshot: ${url.href}`);
      if (!existsSync(path) && extname(path) === '.js')
        path = path.slice(0, -3) + '.ts';
      path = realpathSync(path);
      if (!inside(path))
        throw new Error(`symlink import escapes snapshot: ${url.href}`);
      const resolved = pathToFileURL(path);
      resolved.search = url.search;
      resolved.searchParams.set('rockyBoot', identity);
      return resolved.href;
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (!scoped(context.parentURL)) return nextResolve(specifier, context);
        if (
          specifier === '@rocky/sdk' ||
          specifier === 'zod' ||
          specifier.startsWith('zod/')
        ) {
          return nextResolve(specifier, {
            ...context,
            parentURL: import.meta.url,
          });
        }
        if (specifier.startsWith('node:'))
          return nextResolve(specifier, context);
        if (
          specifier.startsWith('.') ||
          specifier.startsWith('/') ||
          specifier.startsWith('file:')
        ) {
          return {
            url: localUrl(new URL(specifier, context.parentURL)),
            shortCircuit: true,
          };
        }
        throw new Error(
          `unsupported import ${JSON.stringify(specifier)}; use @rocky/sdk, zod, node: builtins or snapshot-relative files`,
        );
      },
      load(url, context, nextLoad) {
        if (!scoped(url)) return nextLoad(url, context);
        const path = fileURLToPath(url);
        if (['.ts', '.mts', '.js', '.mjs'].includes(extname(path))) {
          const source = readFileSync(path, 'utf8');
          return {
            format: 'module',
            source:
              path.endsWith('.ts') || path.endsWith('.mts')
                ? stripTypeScriptTypes(source, {
                    mode: 'strip',
                    sourceUrl: url,
                  })
                : source,
            shortCircuit: true,
          };
        }
        return nextLoad(url, context);
      },
    });
    const module = await import(
      localUrl(pathToFileURL(join(root, 'workflow.ts')))
    );
    const table: unknown = module.default;
    if (!Array.isArray(table) || table.length === 0)
      throw new Error('default export must be a nonempty Trigger table');
    const seen = new Set<string>();
    return Array.from(table, (binding: unknown) => {
      if (
        !binding ||
        typeof binding !== 'object' ||
        !('kind' in binding) ||
        !('workflow' in binding) ||
        typeof binding.workflow !== 'function'
      ) {
        throw new Error(
          'each binding must contain a supported kind and callable workflow',
        );
      }
      let descriptor: TriggerSelector;
      if (binding.kind === 'linear.onDelegate') {
        descriptor = { kind: 'linear.onDelegate' };
      } else if (
        binding.kind === 'manual' &&
        'name' in binding &&
        typeof binding.name === 'string' &&
        binding.name.trim().length > 0
      ) {
        descriptor = { kind: 'manual', name: binding.name };
      } else
        throw new Error(
          'only linear.onDelegate(workflow) and manual(nonemptyName, workflow) bindings are supported',
        );
      const key =
        descriptor.kind === 'manual'
          ? `manual:${descriptor.name}`
          : descriptor.kind;
      if (seen.has(key)) throw new Error(`duplicate Trigger ${key}`);
      seen.add(key);
      return { descriptor, workflow: binding.workflow as Workflow };
    });
  } catch (error) {
    throw new WorkflowLoadError(
      'invalid-workflow',
      file,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      'Fix the named import or default export in .rocky/workflow.ts; use a nonempty table of unique linear.onDelegate(workflow) and manual(name, workflow) bindings, then retry.',
    );
  }
}

export async function loadSnapshotWorkflow(
  snapshotDir: string,
  selector: TriggerSelector,
): Promise<Workflow> {
  const bindings = await importSnapshotTriggers(snapshotDir);
  return resolveSnapshotTrigger(
    bindings.map(({ descriptor, workflow }) => ({ ...descriptor, workflow })),
    selector,
  ).workflow;
}
