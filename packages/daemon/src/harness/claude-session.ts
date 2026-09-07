import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessInvocation } from './types.js';

interface SessionRoute {
  sessionId: string;
  projects: string;
  record: string;
  directory: string;
  receipt: string;
}

function ownedPath(path: unknown, route: SessionRoute): string {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== `${route.sessionId}.jsonl`) throw new Error('Claude returned an unexpected session path');
  const source = resolve(path);
  const within = relative(route.projects, source);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Claude session path is outside the configured projects directory');
  return source;
}

/** Only native session artifacts are routed. HOME, config and credentials stay in place. */
export async function prepareClaudeSession(input: Pick<HarnessInvocation, 'env' | 'transcriptPath'> & { cwd?: string }, sessionId: string, resume = false) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(sessionId)) throw new Error('Invalid Claude session ID');
  const directory = `${resolve(input.transcriptPath)}.claude`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const route: SessionRoute = {
    sessionId,
    projects: resolve(input.cwd ?? process.cwd(), input.env.CLAUDE_CONFIG_DIR || join(input.env.HOME ?? homedir(), '.claude'), 'projects'),
    record: join(directory, `${sessionId}.jsonl`),
    directory: join(directory, sessionId),
    receipt: join(directory, `${sessionId}.route.json`),
  };
  if (resume) {
    const stored = JSON.parse(await readFile(route.receipt, 'utf8'));
    if (stored.sessionId !== sessionId || stored.ready !== true) throw new Error('Invalid Claude session routing receipt');
    await lstat(route.record);
    await routeClaudeSession({ session_id: sessionId, transcript_path: stored.path }, route);
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    route,
    hook: { type: 'command', command: [process.execPath, fileURLToPath(import.meta.url), JSON.stringify(route)].map(quote).join(' '), timeout: 10 },
    verify() {
      const stored = JSON.parse(readFileSync(route.receipt, 'utf8'));
      const path = ownedPath(stored.path, route);
      if (stored.sessionId !== sessionId || stored.ready !== true || !lstatSync(path).isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== route.record) throw new Error('Claude did not establish Run-owned session storage');
    },
    async dispose() {
      let stored;
      try { stored = JSON.parse(await readFile(route.receipt, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (stored.sessionId !== sessionId) throw new Error('Invalid Claude session routing receipt');
      const path = ownedPath(stored.path, route);
      for (const [source, target] of [[path, route.record], [join(dirname(path), sessionId), route.directory]]) {
        try {
          const current = await lstat(source);
          if (!current.isSymbolicLink() || resolve(dirname(source), await readlink(source)) !== target) {
            if (!stored.ready) continue;
            throw new Error('Claude session routing changed; preserve the native artifacts and repair routing');
          }
          await unlink(source);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    },
  };
}

/** SessionStart supplies the CLI's actual path, including its long-path encoding. */
export async function routeClaudeSession(input: { session_id?: unknown; transcript_path?: unknown }, route: SessionRoute): Promise<void> {
  if (input.session_id !== route.sessionId) throw new Error('Claude returned an unexpected session ID');
  const path = ownedPath(input.transcript_path, route);
  await mkdir(route.projects, { recursive: true, mode: 0o700 });
  let ancestor = dirname(path);
  while (!(await lstat(ancestor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; }))) ancestor = dirname(ancestor);
  const physical = relative(await realpath(route.projects), await realpath(ancestor));
  if (physical.startsWith('..') || isAbsolute(physical)) throw new Error('Claude project directory points outside its configured store');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Persist ownership before linking, so a partial failure can remove only our aliases.
  await writeFile(route.receipt, JSON.stringify({ sessionId: route.sessionId, path, ready: false }), { mode: 0o600 });
  for (const [from, to, directory] of [[path, route.record, false], [join(dirname(path), route.sessionId), route.directory, true]] as const) {
    const current = await lstat(from).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (current?.isSymbolicLink()) {
      if (resolve(dirname(from), await readlink(from)) !== to) throw new Error('Claude session path already belongs to another target');
      continue;
    }
    if (current) {
      const target = await lstat(to).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (target) throw new Error('Conflicting Claude session artifacts; preserve both copies');
      if (directory ? !current.isDirectory() : !current.isFile()) throw new Error('Unexpected Claude session artifact type');
      await rename(from, to);
      await chmod(to, directory ? 0o700 : 0o600);
    } else if (directory) await mkdir(to, { recursive: true, mode: 0o700 });
    await symlink(to, from, directory ? 'dir' : 'file');
  }
  await writeFile(route.receipt, JSON.stringify({ sessionId: route.sessionId, path, ready: true }), { mode: 0o600 });
}

// Invoked by the trusted SessionStart hook, never by importing the module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    await routeClaudeSession(JSON.parse(input), JSON.parse(process.argv[2]));
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch {
    process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Rocky could not establish Run-owned Claude session storage; check the Run and configured projects directories' }));
  }
}
