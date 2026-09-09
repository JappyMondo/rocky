/**
 * `rocky repo add|list|remove` (NG-521).
 *
 * `add` **clones eagerly**, and that is the whole reason the command exists in
 * this shape: a bad url or a missing SSH key has to fail here, at a terminal,
 * with a human present to fix it — not inside a Run an hour later where the
 * only evidence is a failed Step. So nothing is written to `config.json` until
 * the clone has actually worked.
 *
 * These talk to `~/.rocky` directly rather than through the daemon's API. The
 * clone is the point of the command and it needs the developer's own ambient
 * git credentials, which the daemon may not have if it is running as a service;
 * and the daemon picks the new entry up through its config watcher anyway
 * (NG-578's hot reload).
 */
import { readFile, rm } from 'node:fs/promises';

import {
  CloneError,
  canonicalRemote,
  cloneStatus,
  createRepoContext,
  ensureInstanceLayout,
  exportRepositoryProfile,
  listRepositoryProfiles,
  newSeedRepositoryProfile,
  parseRepositoryProfile,
  readRepositoryProfile,
  ensureClone,
  readInstanceConfig,
  rockyPaths,
  writeRepositoryProfile,
  writeInstanceConfig,
  type InstanceConfig,
  type RepoEntry,
} from '@rocky/daemon';

import type { CliIo } from './cli.js';

export interface AddRepoOptions {
  name?: string;
  label?: string;
  baseBranch?: string;
}

/** Non-zero exit with a message, and nothing half-written behind it. */
class Refused extends Error {}

/**
 * `git@github.com:digimondo/niotix.git` → `niotix`, and likewise for https and
 * `file://`. Repo names become directory names under `~/.rocky/repos`, so
 * anything that does not survive that is refused rather than mangled into
 * something plausible — `--name` is the fix.
 */
export function repoNameFromUrl(url: string): string | undefined {
  const last = url
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .pop();

  return last !== undefined && /^[A-Za-z0-9._-]+$/.test(last) && last !== '.' && last !== '..' // prettier-ignore
    ? last
    : undefined;
}

export async function addRepo(
  io: CliIo,
  url: string,
  options: AddRepoOptions = {},
): Promise<void> {
  const paths = rockyPaths();

  try {
    const config = await readInstanceConfig(paths);
    const name = options.name ?? repoNameFromUrl(url);

    if (name === undefined) {
      throw new Refused(
        `Rocky could not work out a repo name from ${url}. Pass one with \`--name\` — letters, digits, dot, dash and underscore only, since it becomes a directory name under ~/.rocky/repos.`,
      );
    }

    assertNameFree(config, name);
    const label = options.label ?? name;
    assertLabelFree(config, label);

    // Eagerly, and before anything is written.
    io.out(`Cloning ${url} into ${paths.repo(name)}…`);
    const clone = await ensureClone(
      createRepoContext({ identity: config.identity, paths }),
      { name, url },
    );

    const baseBranch = options.baseBranch ?? clone.defaultBranch;
    if (baseBranch === undefined) {
      throw new Refused(
        `Cloned ${url}, but it has no default branch for Rocky to use as \`baseBranch\` — it may be empty. Re-run with \`--base-branch <branch>\`.`,
      );
    }

    // Create the profile before publishing the route. A clean checkout is
    // enough: no `.rocky/` is read or written, and a failed profile write
    // leaves no route that could later select repository-controlled config.
    await ensureInstanceLayout(paths);
    await writeRepositoryProfile(
      paths,
      await newSeedRepositoryProfile({
        id: name,
        remote: url,
        defaults: config.workflowDefaults,
      }),
    );
    const entry: RepoEntry = { name, url, baseBranch, label, profile: name };
    await writeInstanceConfig(paths, {
      ...config,
      repos: [...config.repos, entry],
    });

    io.out(
      `Added "${name}" — runnable local profile \`${name}\`, base branch \`${baseBranch}\`, routed by the Linear label \`${label}\`.`,
    );
    io.out(
      'Put that label on an issue and delegate it to Rocky. The profile is local; repository .rocky files are ignored. A running daemon picks this up without a restart.',
    );
  } catch (error) {
    fail(io, error);
  }
}

export async function listRepos(io: CliIo): Promise<void> {
  const paths = rockyPaths();

  try {
    const config = await readInstanceConfig(paths);

    if (config.repos.length === 0) {
      io.out(
        'No repos configured. `rocky repo add <url>` clones one and gives it a Linear label to route by.',
      );
      return;
    }

    const cloned = new Map(
      (
        await cloneStatus(
          createRepoContext({ identity: config.identity, paths }),
          config.repos,
        )
      ).map((status) => [status.name, status]),
    );

    io.out(
      table([
        ['REPO', 'LABEL', 'BASE', 'CLONE', 'URL'],
        ...config.repos.map((repo) => [
          repo.name,
          repo.label,
          repo.baseBranch,
          cloned.get(repo.name)?.cloned === true ? 'cloned' : 'not cloned yet',
          repo.url,
        ]),
      ]),
    );

    if (config.groups.length > 0) {
      io.out('');
      io.out(
        table([
          ['GROUP', 'LABEL', 'MEMBERS'],
          ...config.groups.map((group) => [
            group.name,
            group.label,
            group.repos
              .map((member) =>
                member === group.workflow ? `${member} (lead)` : member,
              )
              .join(', '),
          ]),
        ]),
      );
    }
  } catch (error) {
    fail(io, error);
  }
}

/**
 * One line for `rocky status`: how many repos are configured and which of them
 * Rocky has not managed to clone yet. Read from `~/.rocky` rather than from
 * the daemon, because the clone state *is* the filesystem — and NG-595, which
 * owns the daemon's status surface, can move it behind the API when it wires
 * the config store into boot.
 */
export async function repoSummary(): Promise<string> {
  const paths = rockyPaths();
  const config = await readInstanceConfig(paths);

  if (config.repos.length === 0) {
    return 'No repos configured — `rocky repo add <url>` to add one.';
  }

  const missing = (
    await cloneStatus(
      createRepoContext({ identity: config.identity, paths }),
      config.repos,
    )
  )
    .filter((status) => !status.cloned)
    .map((status) => status.name);

  const configured = `${config.repos.length} ${config.repos.length === 1 ? 'repo' : 'repos'} configured`;

  return missing.length === 0
    ? `${configured}, all cloned.`
    : `${configured}, ${missing.length} not cloned yet: ${missing.join(', ')}.`;
}

export async function removeRepo(io: CliIo, name: string): Promise<void> {
  const paths = rockyPaths();

  try {
    const config = await readInstanceConfig(paths);

    if (!config.repos.some((repo) => repo.name === name)) {
      throw new Refused(
        `There is no repo entry called "${name}"${config.repos.length > 0 ? ` — Rocky knows ${quoteList(config.repos.map((repo) => repo.name))}` : ''}. \`rocky repo list\` shows them.`,
      );
    }

    const groups = config.groups.filter((group) => group.repos.includes(name));
    if (groups.length > 0) {
      throw new Refused(
        `"${name}" is a member of the repo ${groups.length === 1 ? 'group' : 'groups'} ${quoteList(groups.map((group) => group.name))}, and a group with a missing member would refuse every delegation routed to it. Take it out of ${groups.length === 1 ? 'that group' : 'those groups'} in ~/.rocky/config.json first.`,
      );
    }

    await writeInstanceConfig(paths, {
      ...config,
      repos: config.repos.filter((repo) => repo.name !== name),
    });

    io.out(`Removed the "${name}" entry from ~/.rocky/config.json.`);
    // Rocky never destroys work, only its own scaffolding (NG-574) — and a
    // clone can hold the only copy of a parked Run's branch, so deleting it
    // here is not this command's call to make.
    io.out(
      `Its clone is still at ${paths.repo(name)}; delete it by hand once you are sure no Run needs the branches in it.`,
    );
  } catch (error) {
    fail(io, error);
  }
}

/** Local-only profile operations. They never read a target checkout. */
export async function listProfiles(io: CliIo): Promise<void> {
  const paths = rockyPaths();
  try {
    const profiles = await listRepositoryProfiles(paths);
    io.out(
      profiles.length === 0
        ? 'No local profiles. `rocky repo add <url>` creates one, or import a secret-safe profile JSON.'
        : table([
            ['PROFILE', 'REMOTE', 'HARNESS'],
            ...profiles.map((profile) => [
              profile.id,
              profile.remote,
              profile.grants.harness,
            ]),
          ]),
    );
  } catch (error) {
    fail(io, error);
  }
}

export async function exportProfile(io: CliIo, id: string): Promise<void> {
  const paths = rockyPaths();
  try {
    io.out(
      JSON.stringify(
        exportRepositoryProfile(await readRepositoryProfile(paths, id)),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(io, error);
  }
}

export async function importProfile(io: CliIo, file: string): Promise<void> {
  const paths = rockyPaths();
  try {
    const profile = parseRepositoryProfile(
      JSON.parse(await readFile(file, 'utf8')) as unknown,
      file,
    );
    await ensureInstanceLayout(paths);
    await writeRepositoryProfile(paths, profile);
    io.out(
      `Imported local profile "${profile.id}" for ${profile.remote}. Use \`rocky repo profile use <repo> ${profile.id}\` to assign it.`,
    );
  } catch (error) {
    fail(io, error);
  }
}

export async function useProfile(
  io: CliIo,
  repoName: string,
  id: string,
): Promise<void> {
  const paths = rockyPaths();
  try {
    const config = await readInstanceConfig(paths);
    const repo = config.repos.find((entry) => entry.name === repoName);
    if (!repo)
      throw new Refused(
        `There is no repo entry called "${repoName}". \`rocky repo list\` shows them.`,
      );
    const profile = await readRepositoryProfile(paths, id);
    if (profile.remote !== canonicalRemote(repo.url)) {
      throw new Refused(
        `Profile "${id}" is for ${profile.remote}, not ${canonicalRemote(repo.url)}. Rocky will not assign a profile to another remote.`,
      );
    }
    await writeInstanceConfig(paths, {
      ...config,
      repos: config.repos.map((entry) =>
        entry.name === repoName ? { ...entry, profile: id } : entry,
      ),
    });
    io.out(`Repo "${repoName}" now uses local profile "${id}".`);
  } catch (error) {
    fail(io, error);
  }
}

/** Explicitly migrate a legacy route without consulting its checkout. */
export async function seedProfile(io: CliIo, repoName: string): Promise<void> {
  const paths = rockyPaths();
  try {
    const config = await readInstanceConfig(paths);
    const repo = config.repos.find((entry) => entry.name === repoName);
    if (!repo)
      throw new Refused(
        `There is no repo entry called "${repoName}". \`rocky repo list\` shows them.`,
      );
    const id = repo.profile ?? repo.name;
    await ensureInstanceLayout(paths);
    await writeRepositoryProfile(
      paths,
      await newSeedRepositoryProfile({
        id,
        remote: repo.url,
        defaults: config.workflowDefaults,
      }),
    );
    await writeInstanceConfig(paths, {
      ...config,
      repos: config.repos.map((entry) =>
        entry.name === repoName ? { ...entry, profile: id } : entry,
      ),
    });
    io.out(
      `Repo "${repoName}" now uses runnable local profile "${id}". Repository .rocky files remain ignored.`,
    );
  } catch (error) {
    fail(io, error);
  }
}

export async function deleteProfile(io: CliIo, id: string): Promise<void> {
  const paths = rockyPaths();
  try {
    const config = await readInstanceConfig(paths);
    const assigned = config.repos.filter((repo) => repo.profile === id);
    if (assigned.length > 0) {
      throw new Refused(
        `Profile "${id}" is assigned to ${quoteList(assigned.map((repo) => repo.name))}. Assign another profile first; Rocky will not leave a route without one.`,
      );
    }
    await readRepositoryProfile(paths, id);
    await rm(paths.profile(id));
    io.out(`Deleted local profile "${id}". It did not change any repository.`);
  } catch (error) {
    fail(io, error);
  }
}

function assertNameFree(config: InstanceConfig, name: string): void {
  if (config.repos.some((repo) => repo.name === name)) {
    throw new Refused(
      `There is already a repo entry called "${name}". Give this one another name with \`--name\`, or \`rocky repo remove ${name}\` first.`,
    );
  }
}

function assertLabelFree(config: InstanceConfig, label: string): void {
  const key = label.trim().toLowerCase();
  const taken =
    config.repos.find((repo) => repo.label.trim().toLowerCase() === key)
      ?.name ??
    config.groups.find((group) => group.label.trim().toLowerCase() === key)
      ?.name;

  if (taken !== undefined) {
    // One label, one destination — otherwise a delegation carrying it is an
    // ambiguous Refusal rather than a Run (NG-578).
    throw new Refused(
      `The label \`${label}\` already routes to "${taken}", and Rocky will not guess between two destinations. Pass a different one with \`--label\`.`,
    );
  }
}

function fail(io: CliIo, error: unknown): void {
  if (error instanceof Refused || error instanceof CloneError) {
    io.err(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

/** Left-aligned columns, so `repo list` is readable in a terminal. */
function table(rows: readonly string[][]): string {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );

  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column]),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
