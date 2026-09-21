import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import type { WorkflowContext, WorkflowInput } from '@rocky/sdk';
import type { WorkspaceRepository, DevService } from '@rocky/local-contracts';
import { resolveUiEndpoint } from './ui-endpoint.js';
import { sourceControlEnv } from '../config/source-control.js';
import { startCommand } from '../run/process.js';

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Catalog commands use non-interactive shells. Load the user's existing nvm
// lazily, once per shell, without selecting or installing a Node version.
const versionManagerShell = `if ! command -v nvm >/dev/null 2>&1; then
  nvm() {
    unset -f nvm
    export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
    if [ ! -r "$NVM_DIR/nvm.sh" ]; then
      printf '%s\\n' 'Rocky: nvm is unavailable. Install it separately or configure NVM_DIR.' >&2
      return 127
    fi
    . "$NVM_DIR/nvm.sh" --no-use && nvm "$@"
  }
fi
`;
const envValue = (s: string) =>
  /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(s)
    ? `"${s.slice(0, -1)}:?Required environment variable is missing}"`
    : quote(s);
export function catalogEntries(repos: WorkspaceRepository[]) {
  return repos.flatMap((repo) =>
    (repo.commands ?? []).map((command) => ({
      id: `${repo.id}/${command.id}`,
      repository: repo,
      command,
    })),
  );
}
export function serviceEntries(repos: WorkspaceRepository[]) {
  return repos.flatMap((repo) =>
    (repo.services ?? []).map((service) => ({
      id: `${repo.id}/${service.id}`,
      repository: repo,
      service,
    })),
  );
}
export function dependencyOrder<T extends { id: string }>(
  entries: T[],
  selected: string[],
  dependencies: (entry: T) => string[],
): T[] {
  const done = new Set<string>(),
    pending = new Set<string>(),
    result: T[] = [];
  const visit = (id: string) => {
    if (done.has(id)) return;
    const entry = entries.find((entry) => entry.id === id);
    if (!entry || pending.has(id))
      throw Error(`Missing or cyclic dependency: ${id}`);
    pending.add(id);
    dependencies(entry).forEach(visit);
    pending.delete(id);
    done.add(id);
    result.push(entry);
  };
  selected.forEach(visit);
  return result;
}
export class WorkspaceExecution {
  private running: Array<{
    id: string;
    pid: number;
    repo: WorkspaceRepository;
    service: DevService;
  }> = [];
  private endpoints: Record<string, Record<string, string>> = {};
  constructor(
    private ctx: WorkflowContext,
    private workspace: WorkflowInput,
    readonly repos: WorkspaceRepository[],
    private runDir = process.env.ROCKY_RUN_DIR ?? '',
  ) {}
  private environment(
    repo: WorkspaceRepository,
    overrides: Record<string, string>,
  ) {
    // Resolve nonsecret access settings normally, but preserve token references as
    // variable names so the journal never contains their expanded values.
    const inherited = { ...process.env };
    for (const platform of ['github', 'gitlab'] as const) {
      const name = repo.sourceControl?.[platform]?.tokenEnv;
      if (name) inherited[name] = '${' + name + '}';
    }
    const effective = sourceControlEnv(repo.sourceControl, inherited);
    const assignments: Record<string, string> = { ...overrides };
    const unset: string[] = [];
    for (const [key, value] of Object.entries(effective)) {
      if (value === inherited[key]) continue;
      if (value === undefined) unset.push(key);
      else assignments[key] = value;
    }
    const exported = Object.entries(assignments)
      .map(([key, value]) => `${key}=${envValue(value)}`)
      .join(' ');
    return `${unset.length ? `unset ${unset.join(' ')}; ` : ''}${exported ? `export ${exported}; ` : ''}`;
  }
  private root(repo: WorkspaceRepository) {
    const member = this.workspace.members.find(
      (member) => member.name === repo.name,
    );
    if (!member)
      throw Error(`Repository ${repo.name} is not in this run workspace.`);
    return resolve(this.runDir, 'workspace', member.path);
  }
  private async shell(
    repo: WorkspaceRepository,
    task: { cwd: string; env: Record<string, string> },
    command: string,
  ) {
    const root = await realpath(this.root(repo));
    const cwd = await realpath(resolve(root, task.cwd));
    const rel = relative(root, cwd);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw Error(`Working directory escapes ${repo.name}.`);
    return `cd -- ${quote(cwd)} && { ${this.environment(repo, task.env)}${versionManagerShell}${command}\n}`;
  }
  async command(id: string, label: string) {
    const entry = catalogEntries(this.repos).find((entry) => entry.id === id);
    if (!entry) throw Error(`Unknown configured command: ${id}`);
    return this.ctx.exec(
      await this.shell(entry.repository, entry.command, entry.command.command),
      { label, timeoutMs: entry.command.timeoutMs },
    );
  }
  async start(selected: string[], label: string) {
    const entries = dependencyOrder(
      serviceEntries(this.repos),
      selected,
      (entry) => entry.service.dependsOn,
    );
    const endpoints = this.endpoints;
    try {
      for (const [index, entry] of entries.entries()) {
        const { service, repository, id } = entry;
        if (endpoints[id]) continue;
        const port =
          this.ctx.ports[
            serviceEntries(this.repos).findIndex((entry) => entry.id === id)
          ];
        if (
          !port &&
          service.endpoints.some(
            (endpoint) => endpoint.locator.kind === 'assigned-port',
          )
        )
          throw Error(
            `Reserve at least ${index + 1} UI ports for ${id}, or use a dynamic endpoint.`,
          );
        const log = join(
          this.runDir,
          `service-${repository.id}-${service.id}.log`,
        );
        const task = {
          ...service,
          env: {
            ...service.env,
            ...(port && service.portEnv
              ? { [service.portEnv]: String(port) }
              : {}),
          },
        };
        // The run runner owns process groups; shutdown can terminate the whole service tree.
        const cwd = await realpath(resolve(this.root(repository), service.cwd));
        const root = await realpath(this.root(repository));
        if (cwd !== root && !cwd.startsWith(`${root}/`))
          throw Error('Service cwd escapes repository.');
        const started = await this.ctx.exec(
          `cd -- ${quote(cwd)} && { ${this.environment(repository, task.env)}${service.start}\n} > ${quote(log)} 2>&1`,
          { background: true, label: `${label}: start ${id}` },
        );
        this.running.push({ id, pid: started.pid, repo: repository, service });
        let ready = false;
        for (let attempt = 0; attempt < service.readiness.attempts; attempt++) {
          try {
            const text = await readFile(log, 'utf8').catch(() => '');
            const values: Record<string, string> = {};
            for (const endpoint of service.endpoints) {
              const url = await resolveUiEndpoint(endpoint.locator, {
                port: port ?? 0,
                log: text,
                workspace: root,
                execute: async (command) => {
                  // Like the HTTP probe, resolve anew on every Boot. Replaying a
                  // journaled command here would reuse yesterday's dynamic port.
                  const probe = startCommand(
                    await this.shell(repository, task, command),
                    { cwd: root, background: false, timeoutMs: 10000 },
                  );
                  try {
                    const result = await probe.result;
                    if (!('exitCode' in result) || result.exitCode)
                      throw Error('Endpoint resolver failed.');
                    return result.stdout;
                  } finally {
                    await probe.stop();
                  }
                },
              });
              if (url) values[endpoint.name] = url;
            }
            const url = values[service.readiness.endpoint];
            if (url) {
              const response = await fetch(url, {
                signal: AbortSignal.timeout(service.readiness.intervalMs),
              });
              ready = response.ok;
              await response.body?.cancel();
            }
            if (
              ready &&
              Object.keys(values).length === service.endpoints.length
            ) {
              endpoints[id] = values;
              break;
            }
            ready = false;
          } catch {
            /* Retry booting endpoints; failure is recorded below. */
          }
          await new Promise((done) =>
            setTimeout(done, service.readiness.intervalMs),
          );
        }
        const receipt = await this.ctx.step(
          `${label}: endpoints ${id}`,
          async () => ({ ready, endpoints: endpoints[id] ?? {} }),
        );
        if (!receipt.ready)
          throw Error(
            `Service ${id} did not become ready. Check its command, endpoint and prerequisites.`,
          );
        // Use this Boot's live endpoint; the receipt records evidence, not a reusable dynamic port.
        if (!ready)
          throw Error(`Service ${id} could not restart for this Boot.`);
      }
      return endpoints;
    } catch (error) {
      await this.stop(label);
      throw error;
    }
  }
  async stop(label: string) {
    this.endpoints = {};
    for (const entry of this.running.splice(0).reverse()) {
      try {
        if (entry.service.stop)
          await this.ctx.exec(
            await this.shell(entry.repo, entry.service, entry.service.stop),
            { label: `${label}: stop ${entry.id}`, timeoutMs: 10000 },
          );
      } finally {
        await this.ctx.exec(`kill -TERM -${entry.pid} 2>/dev/null || true`, {
          label: `${label}: cleanup ${entry.id}`,
        });
      }
    }
  }
}
