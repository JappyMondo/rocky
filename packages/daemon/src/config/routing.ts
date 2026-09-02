/**
 * Mapping a delegated Linear issue to a repo entry or a repo group (NG-578).
 *
 * Every outcome is a value, including the misses: a delegation Rocky cannot
 * place is a **Refusal** — declining while naming the exact fix, never a
 * silent no (CONTEXT.md). NG-598 posts these into the agent session; the
 * lookup's job is to produce the sentence.
 */
import {
  labelKey,
  type Credentials,
  type InstanceConfig,
  type RepoEntry,
  type RepoGroup,
} from './schema.js';

/** What routing knows about the issue. Labels and team, nothing more. */
export interface Delegation {
  labels: string[];
  /** The issue's Linear team, for the optional `teams` filter. */
  team?: string;
}

export interface RepoRoute {
  kind: 'repo';
  repo: RepoEntry;
}

export interface GroupRoute {
  kind: 'group';
  group: RepoGroup;
  /** The member whose `.rocky/` the Run executes. */
  lead: RepoEntry;
  /** Every member, in the order the group lists them. */
  members: RepoEntry[];
}

export interface RouteRefusal {
  kind: 'refusal';
  reason: 'no-match' | 'ambiguous' | 'team-filtered';
  /** Ready to post into the agent session. Names the fix. */
  message: string;
}

export type Route = RepoRoute | GroupRoute | RouteRefusal;

function quoteList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}

/** Every label Rocky answers to, repos and groups together. */
export function routableLabels(config: InstanceConfig): string[] {
  return [
    ...config.repos.map((repo) => repo.label),
    ...config.groups.map((group) => group.label),
  ];
}

export function findRepo(
  config: InstanceConfig,
  name: string,
): RepoEntry | undefined {
  return config.repos.find((repo) => repo.name === name);
}

/**
 * The group's lead and members as entries. Throws rather than returning a
 * refusal: the schema already guarantees a parsed config's groups reference
 * real repos, so a failure here is a caller's bad name, not a user's typo.
 */
export function resolveGroup(
  config: InstanceConfig,
  groupName: string,
): { group: RepoGroup; lead: RepoEntry; members: RepoEntry[] } {
  const group = config.groups.find((candidate) => candidate.name === groupName);
  if (!group) {
    throw new Error(`no repo group named "${groupName}"`);
  }
  return { group, ...membersOf(config, group) };
}

function membersOf(
  config: InstanceConfig,
  group: RepoGroup,
): { lead: RepoEntry; members: RepoEntry[] } {
  const members = group.repos.map((name) => {
    const repo = findRepo(config, name);
    if (!repo) {
      throw new Error(
        `repo group "${group.name}" references unknown repo "${name}"`,
      );
    }
    return repo;
  });

  const lead = members.find((repo) => repo.name === group.workflow);
  if (!lead) {
    throw new Error(
      `repo group "${group.name}" names lead "${group.workflow}", which is not a member`,
    );
  }

  return { lead, members };
}

/**
 * Every group a repo belongs to. A repo may sit in several and stay routable
 * alone by its own label (NG-578).
 */
export function groupsForRepo(
  config: InstanceConfig,
  repoName: string,
): RepoGroup[] {
  return config.groups.filter((group) => group.repos.includes(repoName));
}

/**
 * The env injected into every Run on a repo: the entry's own `env`, plus that
 * repo's section of `credentials.json`. Secrets are referenced by repo name
 * rather than inlined into `config.json`, and they win — so a placeholder left
 * in the readable file can never mask the real value.
 */
export function resolveRepoEnv(
  config: InstanceConfig,
  credentials: Credentials,
  repoName: string,
): Record<string, string> {
  return {
    ...findRepo(config, repoName)?.env,
    ...credentials.repos[repoName],
  };
}

export function route(config: InstanceConfig, delegation: Delegation): Route {
  if (config.repos.length === 0) {
    return {
      kind: 'refusal',
      reason: 'no-match',
      message:
        'There are no repo entries in `~/.rocky/config.json`, so nothing can be routed to. Add one with `rocky repo add <url>`, giving it the Linear label you delegate with.',
    };
  }

  const wanted = new Set(delegation.labels.map(labelKey));

  const groups = config.groups.filter((group) =>
    wanted.has(labelKey(group.label)),
  );
  const byLabel = config.repos.filter((repo) =>
    wanted.has(labelKey(repo.label)),
  );

  // The label matched but the team did not. Worth its own message: the fix is
  // a `teams` edit, not a label one.
  const filteredOut = byLabel.filter((repo) => !teamAllows(repo, delegation));
  const repos = byLabel.filter((repo) => teamAllows(repo, delegation));

  const destinations = [
    ...repos.map((repo) => `repo \`${repo.name}\` (label \`${repo.label}\`)`),
    ...groups.map(
      (group) => `group \`${group.name}\` (label \`${group.label}\`)`,
    ),
  ];

  if (destinations.length > 1) {
    return {
      kind: 'refusal',
      reason: 'ambiguous',
      message: `This issue's labels route to more than one destination — ${destinations.join(' and ')} — and Rocky will not guess which one you meant. Leave exactly one Rocky label on the issue.`,
    };
  }

  if (groups.length === 1) {
    const group = groups[0];
    return { kind: 'group', group, ...membersOf(config, group) };
  }

  if (repos.length === 1) {
    return { kind: 'repo', repo: repos[0] };
  }

  if (filteredOut.length > 0) {
    const explained = filteredOut
      .map(
        (repo) =>
          `repo \`${repo.name}\` answers to \`${repo.label}\` but only for ${quoteList(repo.teams ?? [])}`,
      )
      .join('; ');

    return {
      kind: 'refusal',
      reason: 'team-filtered',
      message: `This issue is on team \`${delegation.team ?? '(none)'}\`, and ${explained}. Add that team to the entry's \`teams\` in \`~/.rocky/config.json\`, or drop \`teams\` to let every team through.`,
    };
  }

  return {
    kind: 'refusal',
    reason: 'no-match',
    message: `No repo entry or repo group is routed by this issue's labels (${delegation.labels.length > 0 ? quoteList(delegation.labels) : 'it has none'}). Rocky routes by ${quoteList(routableLabels(config))} — add one of those to the issue, or add a matching \`label\` to an entry in \`~/.rocky/config.json\`.`,
  };
}

function teamAllows(repo: RepoEntry, delegation: Delegation): boolean {
  if (repo.teams === undefined || repo.teams.length === 0) {
    return true;
  }
  if (delegation.team === undefined) {
    return false;
  }
  return repo.teams.some(
    (team) => labelKey(team) === labelKey(delegation.team as string),
  );
}
