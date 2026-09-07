import { z } from 'zod';
import { ScmError, type ScmAdapterOptions, type ScmHttp } from './http.js';

export interface ScmAbility {
  status: 'allowed' | 'denied' | 'unknown';
  source: string;
  fix: string;
}
export interface ScmProbe {
  repo: string;
  platform: 'github' | 'gitlab';
  merge: ScmAbility;
  rebase: ScmAbility;
  sourcePush: ScmAbility;
  draft: ScmAbility;
  version?: string;
  mergeTrains?: boolean | 'unknown';
}
const ability = (
  status: ScmAbility['status'],
  source: string,
  fix = '',
): ScmAbility => ({ status, source, fix });
const unknown = (source: string) =>
  ability(
    'unknown',
    source,
    'Ask a maintainer to verify token permissions and policy with read-only account/API evidence.',
  );
const denied = (source: string) =>
  ability(
    'denied',
    source,
    'Obtain the named permission on this repository; do not bypass or weaken branch policy.',
  );
const draft = (values: { draft?: boolean }[]) =>
  values.some((value) => typeof value.draft === 'boolean')
    ? ability(
        'allowed',
        'Existing PR/MR native draft boolean observed; transitions require separate authorized fixture evidence.',
      )
    : unknown(
        values.length
          ? 'Native draft boolean is not observable.'
          : 'Unexercised: no PR/MR exists for this source/base.',
      );

export async function probeGitHub(
  options: ScmAdapterOptions,
  http: ScmHttp,
  root: string,
  signal: AbortSignal,
): Promise<ScmProbe> {
  const get = <T>(path: string, schema: z.ZodType<T>) =>
    http.request('GET', path, schema, undefined, signal);
  const user = await get('/user', z.object({ login: z.string() }));
  const scopes = (http.header('/user', 'x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim());
  const repo = await get(
    root,
    z.object({
      private: z.boolean().optional(),
      permissions: z.object({ push: z.boolean().optional() }).optional(),
    }),
  );
  const tokenWrite =
    scopes.includes('repo') ||
    (repo.private === false && scopes.includes('public_repo'));
  const permission =
    repo.permissions?.push === false
      ? denied('Repository permissions.push=false (Contents write missing).')
      : !tokenWrite || repo.permissions?.push !== true
        ? unknown(
            'Contents write is unverified: repository role alone does not prove token scopes.',
          )
        : undefined;
  const branchAbility = async (branch: string): Promise<ScmAbility> => {
    if (permission) return permission;
    try {
      const rules = await get(
        `${root}/rules/branches/${encodeURIComponent(branch)}`,
        z.array(z.object({ type: z.string() })),
      );
      if (
        rules.some((rule) =>
          ['update', 'creation', 'deletion'].includes(rule.type),
        )
      )
        return unknown(
          `Branch ${branch} has restricted update/creation rules; bypass is not permission.`,
        );
      const native = await get(
        `${root}/branches/${encodeURIComponent(branch)}`,
        z.object({ protected: z.boolean() }),
      );
      if (native.protected) {
        const protection = await get(
          `${root}/branches/${encodeURIComponent(branch)}/protection`,
          z.object({
            restrictions: z
              .object({
                users: z.array(z.object({ login: z.string() })),
                teams: z.array(z.unknown()),
              })
              .nullable()
              .optional(),
            lock_branch: z.object({ enabled: z.boolean() }).optional(),
          }),
        );
        if (protection.lock_branch?.enabled)
          return denied(`Branch ${branch} is locked.`);
        if (
          protection.restrictions &&
          !protection.restrictions.users.some(
            (userEntry) => userEntry.login === user.login,
          )
        )
          return protection.restrictions.teams.length
            ? unknown(`Branch ${branch} has team-restricted push policy.`)
            : denied(
                `Account ${user.login} is not allowed to update ${branch}.`,
              );
      }
      return ability(
        'allowed',
        `Classic token scope, repository Contents write, and visible ${branch} branch policy.`,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ScmError)) throw error;
      return unknown(
        `Branch ${branch} policy is not fully observable (HTTP ${error.status ?? 'API schema'}).`,
      );
    }
  };
  const merge = await branchAbility(options.repo.baseBranch);
  const sourcePush = await branchAbility(options.branch);
  const query = new URLSearchParams({
    state: 'all',
    head: `${options.repo.project.split('/')[0]}:${options.branch}`,
    base: options.repo.baseBranch,
  });
  const prs = await http.list(
    `${root}/pulls?${query}`,
    z.object({ draft: z.boolean().optional() }),
    undefined,
    signal,
  );
  return {
    repo: options.repo.id,
    platform: 'github',
    merge,
    sourcePush,
    rebase: sourcePush,
    draft: draft(prs),
  };
}

export async function probeGitLab(
  options: ScmAdapterOptions,
  http: ScmHttp,
  root: string,
  signal: AbortSignal,
): Promise<ScmProbe> {
  const get = <T>(path: string, schema: z.ZodType<T>) =>
    http.request('GET', path, schema, undefined, signal);
  const user = await get(
    '/user',
    z.object({ id: z.number(), username: z.string() }),
  );
  const version = await get('/version', z.object({ version: z.string() }));
  const project = await get(
    root,
    z.object({
      id: z.number(),
      merge_trains_enabled: z.boolean().optional(),
      permissions: z
        .object({
          project_access: z.object({ access_level: z.number() }).nullable(),
          group_access: z.object({ access_level: z.number() }).nullable(),
        })
        .optional(),
    }),
  );
  let scopes: string[] = [];
  try {
    scopes = (
      await get(
        '/personal_access_tokens/self',
        z.object({ scopes: z.array(z.string()) }),
      )
    ).scopes;
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ScmError)) throw error;
    try {
      scopes = (
        await get('/oauth/token/info', z.object({ scope: z.array(z.string()) }))
      ).scope;
    } catch (oauthError) {
      signal.throwIfAborted();
      if (!(oauthError instanceof ScmError)) throw oauthError;
    }
  }
  const role = Math.max(
    project.permissions?.project_access?.access_level ?? 0,
    project.permissions?.group_access?.access_level ?? 0,
  );
  const grantSchema = z.object({
    access_level: z.number().optional(),
    user_id: z.number().nullable().optional(),
    group_id: z.number().nullable().optional(),
  });
  const policies = await http
    .list(
      `${root}/protected_branches`,
      z.object({
        name: z.string(),
        merge_access_levels: z.array(grantSchema),
        push_access_levels: z.array(grantSchema),
        allow_force_push: z.boolean(),
      }),
      undefined,
      signal,
    )
    .catch((error) => {
      signal.throwIfAborted();
      if (!(error instanceof ScmError)) throw error;
      return undefined;
    });
  const matches = (pattern: string, branch: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(branch);
  const branches = new Map<
    string,
    { protected: boolean; can_push?: boolean }
  >();
  for (const branch of new Set([options.repo.baseBranch, options.branch])) {
    try {
      branches.set(
        branch,
        await get(
          `${root}/repository/branches/${encodeURIComponent(branch)}`,
          z.object({
            protected: z.boolean(),
            can_push: z.boolean().optional(),
          }),
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ScmError)) throw error;
    }
  }
  let merge: ScmAbility;
  if (!scopes.includes('api'))
    merge = unknown(
      'API write scope is not verified; read_api is insufficient.',
    );
  else if (role < 30)
    merge = project.permissions
      ? denied('Developer or explicit Allowed to merge membership is missing.')
      : unknown('Project membership is hidden.');
  else {
    const target = branches.get(options.repo.baseBranch);
    if (!target) merge = unknown('Target branch is not observable.');
    else if (!target.protected)
      merge = ability(
        'allowed',
        'API scope and Developer membership on the unprotected target branch.',
      );
    else {
      const matching = policies?.filter((policy) =>
        matches(policy.name, options.repo.baseBranch),
      );
      const grants = matching?.flatMap((policy) => policy.merge_access_levels);
      if (!grants?.length)
        merge = unknown(
          'Protected target Allowed to merge policy is hidden or empty.',
        );
      else if (
        grants.some(
          (grant) =>
            grant.user_id === user.id ||
            (!grant.user_id &&
              !grant.group_id &&
              (grant.access_level ?? 0) > 0 &&
              role >= (grant.access_level ?? Infinity)),
        )
      )
        merge = ability(
          'allowed',
          'API scope and explicit protected-branch Allowed to merge membership.',
        );
      else if (grants.some((grant) => grant.group_id))
        merge = unknown(
          'Allowed to merge requires group membership not proven by the project role.',
        );
      else
        merge = denied(
          `Account ${user.username} is not in ${options.repo.baseBranch}'s Allowed to merge policy.`,
        );
    }
  }
  const source = branches.get(options.branch);
  const sourcePush =
    !scopes.includes('api') || source?.can_push === undefined
      ? unknown('Ordinary source push is not verified.')
      : source.can_push
        ? ability(
            'allowed',
            'API scope and native source branch can_push=true.',
          )
        : denied('Native source branch can_push=false.');
  const sourcePolicies = policies?.filter((policy) =>
    matches(policy.name, options.branch),
  );
  const rebase =
    sourcePush.status !== 'allowed'
      ? sourcePush
      : source?.protected === false
        ? ability(
            'allowed',
            'Source write on an unprotected branch permits platform rebase.',
          )
        : sourcePolicies?.some((policy) => policy.allow_force_push)
          ? ability(
              'allowed',
              'Source write and visible force-push policy permit platform rebase.',
            )
          : denied(
              'Source force-push/rebase is not allowed; ordinary base-merge fallback may be used.',
            );
  const query = new URLSearchParams({
    state: 'all',
    source_branch: options.branch,
    target_branch: options.repo.baseBranch,
  });
  const prs = await http.list(
    `${root}/merge_requests?${query}`,
    z.object({ draft: z.boolean().optional() }),
    undefined,
    signal,
  );
  return {
    repo: options.repo.id,
    platform: 'gitlab',
    merge,
    sourcePush,
    rebase,
    draft: draft(prs),
    version: version.version,
    mergeTrains: project.merge_trains_enabled ?? 'unknown',
  };
}
