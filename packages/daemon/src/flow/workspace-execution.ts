import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
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
export class StaleServiceError extends Error {}
export class ServiceStartupError extends Error {
  constructor(readonly serviceId: string) {
    super(`Service ${serviceId} did not become ready.`);
  }
}
const portLeases = new Set<number>();
export class WorkspaceExecution {
  private leasedPorts = new Set<number>();
  private running: Array<{
    id: string;
    pid: number;
    repo: WorkspaceRepository;
    service: DevService;
  }> = [];
  private endpoints: Record<string, Record<string, string>> = {};
  constructor(
    private ctx: Pick<WorkflowContext, 'exec' | 'step' | 'ports'>,
    private workspace: WorkflowInput,
    readonly repos: WorkspaceRepository[],
    private runDir = process.env.ROCKY_RUN_DIR ?? '',
    private verified = false,
    private signal?: AbortSignal,
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
  async checkSources(repository: string, paths: string[]) {
    const repo = this.repos.find((repo) => repo.name === repository);
    if (!repo) throw Error('Unknown evidence repository.');
    const root = await realpath(this.root(repo));
    for (const path of paths) {
      const file = await realpath(resolve(root, path));
      if (!file.startsWith(`${root}/`) || !(await stat(file)).isFile())
        throw Error('Evidence must be a source file inside the repository.');
    }
  }
  private endpointEnvironment(task: {
    endpointEnv?: Record<string, { service: string; endpoint: string }>;
  }) {
    return Object.fromEntries(
      Object.entries(task.endpointEnv ?? {}).map(([name, reference]) => {
        const value = this.endpoints[reference.service]?.[reference.endpoint];
        if (!value)
          throw Error(
            `Dependency endpoint unavailable: ${reference.service}/${reference.endpoint}`,
          );
        return [name, value];
      }),
    );
  }
  /** The normal runner supplies profile environment and owns the process tree.
   * Only a sanitized assertion receipt touches disk; raw verifier output does not.
   */
  async probe(
    id: string,
    timeoutMs: number,
    checks: string[],
    secretEnv: string[] = [],
  ) {
    const entry = catalogEntries(this.repos).find((entry) => entry.id === id);
    if (!entry) throw Error('Unknown environment verifier.');
    const task = {
      ...entry.command,
      env: { ...entry.command.env, ...this.endpointEnvironment(entry.command) },
    };
    const command = await this.shell(
      entry.repository,
      task,
      entry.command.command,
    );
    const resultFile = join(
      this.runDir,
      `environment-probe-${randomUUID()}.json`,
    );
    const timeout = Math.max(1, Math.min(timeoutMs, entry.command.timeoutMs));
    const script = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
// Keep the owned wrapper alive until the receipt has been consumed and cleaned.
setInterval(() => {}, 1000);
if (${JSON.stringify(secretEnv)}.some(name => !process.env[name])) {
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({exitCode:0, stdout:JSON.stringify({status:'blocked',reason:'credentials'})}), {mode:0o600});
} else {
const child = spawn(${JSON.stringify(command)}, { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
let text = '', overflow = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => { if (text.length + chunk.length > 1048576) { overflow = true; text = ''; } else if (!overflow) text += chunk; });
child.on('close', code => {
  let value; try { value = JSON.parse(text); } catch {}
  const allowed = ${JSON.stringify(checks)};
  const result = {
    exitCode: code === 0 && !overflow ? 0 : 1,
    stdout: JSON.stringify({
      status: ['passed', 'failed', 'blocked'].includes(value?.status) ? value.status : 'failed',
      reason: ['credentials', 'permission', 'external', 'unsupported', 'product'].includes(value?.reason) ? value.reason : undefined,
      checks: allowed.map(id => {
        const found = Array.isArray(value?.checks) ? value.checks.filter(c => c?.id === id) : [];
        return { id, executed: found.length === 1 && found[0].executed === true, passed: found.length === 1 && found[0].passed === true };
      }),
    }),
  };
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result), { mode: 0o600 });
});
}`;
    const child = await this.ctx.exec(
      `${quote(process.execPath)} -e ${quote(script)}`,
      { background: true, label: `Environment probe ${id}` },
    );
    try {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        this.signal?.throwIfAborted();
        const value = await readFile(resultFile, 'utf8').catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return undefined;
            throw e;
          },
        );
        if (value) {
          try {
            return JSON.parse(value) as { exitCode: number; stdout: string };
          } catch {
            /* The writer may still be flushing. */
          }
        }
        process.kill(child.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw Error('Environment probe timed out.');
    } finally {
      await terminateOwnedGroup(child.pid);
      await rm(resultFile, { force: true });
    }
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
  async command(id: string, label: string, timeoutMs?: number) {
    const entry = catalogEntries(this.repos).find((entry) => entry.id === id);
    if (!entry) throw Error(`Unknown configured command: ${id}`);
    return this.ctx.exec(
      await this.shell(
        entry.repository,
        {
          ...entry.command,
          env: {
            ...entry.command.env,
            ...this.endpointEnvironment(entry.command),
          },
        },
        entry.command.command,
      ),
      {
        label,
        timeoutMs: Math.min(
          entry.command.timeoutMs,
          timeoutMs ?? entry.command.timeoutMs,
        ),
      },
    );
  }
  async start(selected: string[], label: string, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    const entries = dependencyOrder(
      serviceEntries(this.repos),
      selected,
      (entry) => entry.service.dependsOn,
    );
    const endpoints = this.endpoints;
    try {
      for (const [index, entry] of entries.entries()) {
        const { service, repository, id } = entry;
        if (endpoints[id]) {
          if (!this.verified) continue;
          let live = false;
          try {
            const owner = this.running.find((entry) => entry.id === id);
            if (!owner) throw Error('Service has no current owner.');
            process.kill(owner.pid, 0);
            const response = await fetch(
              endpoints[id][service.readiness.endpoint],
              {
                signal: AbortSignal.timeout(
                  Math.max(1, Math.min(1000, deadline - Date.now())),
                ),
              },
            );
            live = response.ok;
            await response.body?.cancel();
          } catch {
            live = false;
          }
          const receipt = await this.ctx.step(
            `${label}: recheck ${id}`,
            () => ({ ready: live }),
          );
          if (!receipt.ready) throw new ServiceStartupError(id);
          if (!live)
            throw new StaleServiceError(`Service ${id} crashed on this Boot.`);
          continue;
        }
        const port = this.verified
          ? await availablePort()
          : this.ctx.ports[
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
        if (this.verified && port) this.leasedPorts.add(port);
        const endpointFiles = new Map<string, number | undefined>();
        if (this.verified)
          for (const endpoint of service.endpoints) {
            if (endpoint.locator.kind === 'json-file') {
              const file = resolve(
                this.root(repository),
                endpoint.locator.path,
              );
              endpointFiles.set(
                endpoint.locator.path,
                (await stat(file).catch(() => undefined))?.mtimeMs,
              );
            }
          }
        const log = join(
          this.runDir,
          `service-${repository.id}-${service.id}.log`,
        );
        const task = {
          ...service,
          env: {
            ...service.env,
            ...this.endpointEnvironment(service),
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
          this.verified
            ? `umask 077; ${await this.shell(repository, task, service.start)} 2>&1 | ${quote(process.execPath)} -e ${quote(serviceOutputFilter(service))} > ${quote(log)}`
            : `cd -- ${quote(cwd)} && { ${this.environment(repository, task.env)}${service.start}\n} > ${quote(log)} 2>&1`,
          { background: true, label: `${label}: start ${id}` },
        );
        this.running.push({ id, pid: started.pid, repo: repository, service });
        let ready = false;
        for (let attempt = 0; attempt < service.readiness.attempts; attempt++) {
          this.signal?.throwIfAborted();
          if (this.verified && Date.now() >= deadline) break;
          try {
            if (this.verified) process.kill(started.pid, 0);
            const text = await readFile(log, 'utf8').catch(() => '');
            const values: Record<string, string> = {};
            for (const endpoint of service.endpoints) {
              if (this.verified && endpoint.locator.kind === 'json-file') {
                const file = resolve(root, endpoint.locator.path);
                if (
                  (await stat(file)).mtimeMs ===
                  endpointFiles.get(endpoint.locator.path)
                )
                  throw Error(
                    'Endpoint file was not refreshed by this service launch.',
                  );
              }
              let locator = endpoint.locator;
              if (this.verified && locator.kind === 'output-regex') {
                const candidate = text
                  .split('\n')
                  .find((line) => line.startsWith(`${endpoint.name}\t`))
                  ?.split('\t')[1];
                if (!candidate) continue;
                locator = { kind: 'fixed', url: candidate };
              }
              const url = await resolveUiEndpoint(locator, {
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
              if (url) {
                const parsed = new URL(url);
                if (
                  this.verified &&
                  (parsed.username ||
                    parsed.password ||
                    parsed.search ||
                    parsed.hash ||
                    !['localhost', '127.0.0.1', '[::1]'].includes(
                      parsed.hostname,
                    ))
                )
                  throw Error(
                    'Local environment endpoints must be credential-free loopback URLs.',
                  );
                values[endpoint.name] = url;
              }
            }
            const url = values[service.readiness.endpoint];
            if (url) {
              const response = await fetch(url, {
                signal: AbortSignal.timeout(
                  this.verified
                    ? Math.max(
                        1,
                        Math.min(
                          service.readiness.intervalMs,
                          deadline - Date.now(),
                        ),
                      )
                    : service.readiness.intervalMs,
                ),
              });
              ready = response.ok;
              await response.body?.cancel();
            }
            if (
              ready &&
              Object.keys(values).length === service.endpoints.length
            ) {
              if (this.verified) process.kill(started.pid, 0);
              endpoints[id] = values;
              break;
            }
            ready = false;
          } catch {
            ready = false;
            /* Retry booting endpoints; failure is recorded below. */
          }
          await new Promise((done) =>
            setTimeout(
              done,
              this.verified
                ? Math.max(
                    1,
                    Math.min(
                      service.readiness.intervalMs,
                      deadline - Date.now(),
                    ),
                  )
                : service.readiness.intervalMs,
            ),
          );
        }
        const receipt = await this.ctx.step(
          `${label}: endpoints ${id}`,
          async () => ({ ready, endpoints: endpoints[id] ?? {} }),
        );
        if (!receipt.ready) throw new ServiceStartupError(id);
        // Use this Boot's live endpoint; the receipt records evidence, not a reusable dynamic port.
        if (!ready)
          throw new StaleServiceError(
            `Service ${id} could not restart for this Boot.`,
          );
      }
      return endpoints;
    } catch (error) {
      await this.stop(label);
      throw error;
    }
  }
  async stop(label: string) {
    this.endpoints = {};
    for (const port of this.leasedPorts) portLeases.delete(port);
    this.leasedPorts.clear();
    for (const entry of this.running.splice(0).reverse()) {
      try {
        if (entry.service.stop && !this.verified)
          await this.ctx.exec(
            await this.shell(entry.repo, entry.service, entry.service.stop),
            { label: `${label}: stop ${entry.id}`, timeoutMs: 10000 },
          );
      } finally {
        if (this.verified) {
          // Do not replay a stale kill receipt while leaving this Boot's process alive.
          await terminateOwnedGroup(entry.pid);
        } else {
          await this.ctx.exec(`kill -TERM -${entry.pid} 2>/dev/null || true`, {
            label: `${label}: cleanup ${entry.id}`,
          });
        }
      }
    }
  }
}

// OS-chosen candidates; a bind race is handled by the bounded environment repair
// restarting the owned process with a newly allocated candidate, never an offset.
async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(Error('No port allocated.')));
        return;
      }
      if (portLeases.has(address.port)) {
        server.close(() => {
          availablePort().then(resolve, reject);
        });
        return;
      }
      portLeases.add(address.port);
      server.close((error) => {
        if (error) {
          portLeases.delete(address.port);
          reject(error);
        } else resolve(address.port);
      });
    });
  });
}
// Do not persist arbitrary service output: only endpoint candidates are retained.
// Full diagnostics remain the responsibility of an explicitly configured probe.
function serviceOutputFilter(service: DevService) {
  const patterns = service.endpoints.flatMap((endpoint) =>
    endpoint.locator.kind === 'output-regex'
      ? [{ name: endpoint.name, pattern: endpoint.locator.pattern }]
      : [],
  );
  return `
let buffer = '';
const emitted = new Set();
const patterns = ${JSON.stringify(patterns)};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer = (buffer + chunk).slice(-8192);
  const lines = buffer.split('\\n'); buffer = lines.pop();
  for (const line of lines) for (const recipe of patterns) {
    if (emitted.has(recipe.name)) continue;
    try {
      const match = new RegExp(recipe.pattern).exec(line);
      const value = match?.groups?.url ?? match?.groups?.port;
      if (!value) continue;
      const url = new URL(/^\\d+$/.test(value) ? 'http://127.0.0.1:' + value + '/' : value);
      if (!url.username && !url.password && !url.search && !url.hash && ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        { emitted.add(recipe.name); process.stdout.write(recipe.name + '\\t' + url.origin + '/' + '\\n'); }
    } catch {}
  }
});
`;
}

async function terminateOwnedGroup(pid: number) {
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, name);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const deadline = Date.now() + 200;
  while (Date.now() < deadline && signal(0))
    await new Promise((resolve) => setTimeout(resolve, 10));
  signal('SIGKILL');
}
