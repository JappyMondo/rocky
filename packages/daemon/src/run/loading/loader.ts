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

type SnapshotImportScope = {
  identity: string;
  root: string;
};

let snapshotHooksRegistered = false;

function isInsideSnapshot(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function snapshotImportScope(
  url: string | undefined,
): SnapshotImportScope | undefined {
  if (!url?.startsWith('file:')) return undefined;
  const parsed = new URL(url);
  const identity = parsed.searchParams.get('rockyBoot');
  const root = parsed.searchParams.get('rockySnapshotRoot');
  return identity && root ? { identity, root } : undefined;
}

function localSnapshotUrl(url: URL, scope: SnapshotImportScope) {
  let path = fileURLToPath(url);
  if (!isInsideSnapshot(scope.root, path))
    throw new Error(`import escapes snapshot: ${url.href}`);
  if (!existsSync(path) && extname(path) === '.js')
    path = path.slice(0, -3) + '.ts';
  path = realpathSync(path);
  if (!isInsideSnapshot(scope.root, path))
    throw new Error(`symlink import escapes snapshot: ${url.href}`);
  const resolved = pathToFileURL(path);
  resolved.search = url.search;
  resolved.searchParams.set('rockyBoot', scope.identity);
  resolved.searchParams.set('rockySnapshotRoot', scope.root);
  return resolved.href;
}

function registerSnapshotHooks() {
  if (snapshotHooksRegistered) return;
  snapshotHooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const scope = snapshotImportScope(context.parentURL);
      if (!scope) return nextResolve(specifier, context);
      if (
        specifier === '@rocky/sdk' ||
        specifier === 'zod' ||
        specifier.startsWith('zod/')
      ) {
        // The standalone Rocky tarball bundles its SDK beside this loader.
        // Source builds retain normal package resolution, where this file does
        // not exist and @rocky/sdk remains the workspace dependency.
        if (specifier === '@rocky/sdk') {
          const shippedSdk = new URL('./sdk.js', import.meta.url);
          if (existsSync(shippedSdk))
            return { url: shippedSdk.href, shortCircuit: true };
        }
        return nextResolve(specifier, {
          ...context,
          parentURL: import.meta.url,
        });
      }
      if (specifier.startsWith('node:')) return nextResolve(specifier, context);
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('file:')
      ) {
        return {
          url: localSnapshotUrl(new URL(specifier, context.parentURL), scope),
          shortCircuit: true,
        };
      }
      throw new Error(
        `unsupported import ${JSON.stringify(specifier)}; use @rocky/sdk, zod, node: builtins or snapshot-relative files`,
      );
    },
    load(url, context, nextLoad) {
      const scope = snapshotImportScope(url);
      if (!scope) return nextLoad(url, context);
      const path = fileURLToPath(url);
      if (!isInsideSnapshot(scope.root, path))
        throw new Error(`import escapes snapshot: ${url}`);
      const resolvedPath = realpathSync(path);
      if (!isInsideSnapshot(scope.root, resolvedPath))
        throw new Error(`symlink import escapes snapshot: ${url}`);
      if (['.ts', '.mts', '.js', '.mjs'].includes(extname(resolvedPath))) {
        const source = readFileSync(resolvedPath, 'utf8');
        return {
          format: 'module',
          source:
            resolvedPath.endsWith('.ts') || resolvedPath.endsWith('.mts')
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

/** Runner-owned child only; hooks are process-global across parked Boots. */
export async function importSnapshotTriggers(snapshotDir: string): Promise<
  {
    descriptor: TriggerSelector;
    workflow: Workflow;
  }[]
> {
  const file = join(snapshotDir, 'workflow.ts');
  try {
    const root = realpathSync(snapshotDir);
    const scope = { identity: randomUUID(), root };
    registerSnapshotHooks();
    const module = await import(
      localSnapshotUrl(pathToFileURL(join(root, 'workflow.ts')), scope)
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
