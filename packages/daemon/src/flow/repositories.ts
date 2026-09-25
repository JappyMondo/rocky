import type {
  ScmPr,
  ScmRefusal,
  WorkflowContext,
  WorkflowInput,
} from '@rocky/sdk';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function requireRepositoryResult<T>(value: T | ScmRefusal): T {
  if (value && typeof value === 'object' && 'refused' in value)
    throw new Error(`${value.message}\n${value.fix}`);
  return value as T;
}

/** One delivery set, rebuilt by replaying the same per-repository Steps each boot. */
export class DeliveryRepositories {
  private readonly prs = new Map<string, ScmPr>();
  readonly members: WorkflowInput['members'];
  constructor(
    private readonly ctx: WorkflowContext,
    workspace: WorkflowInput,
  ) {
    this.members = [...workspace.members].sort(
      (a, b) => Number(b.lead) - Number(a.lead),
    );
    if (new Set(this.members.map((m) => m.name)).size !== this.members.length)
      throw new Error('Delivery requires unique repository names.');
  }
  private member(repo: string) {
    const member = this.members.find((m) => m.name === repo);
    if (!member) throw new Error(`Unknown delivery repository: ${repo}`);
    return member;
  }
  private base(repo: string) {
    const branch = this.member(repo).baseBranch;
    return branch ? `refs/remotes/origin/${branch}` : 'origin/HEAD';
  }
  async exec(repo: string, command: string) {
    return this.ctx.exec(
      `cd -- ${quote(this.member(repo).path)} && ${command}`,
      { label: `${repo}: ${command}` },
    );
  }
  async shell(repo: string, command: string) {
    const result = await this.exec(repo, command);
    if (result.exitCode !== 0)
      throw new Error(`${repo}: ${command}\n${result.stderr}`);
    return result.stdout.trim();
  }
  private async push(repo: string, branch: string): Promise<boolean> {
    const command = 'git push origin HEAD';
    const initial = await this.exec(repo, command);
    if (initial.exitCode === 0) return false;
    if (
      !/\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/.test(
        initial.stderr,
      )
    )
      throw new Error(`${repo}: ${command}\n${initial.stderr}`);

    // A previous Boot may have pushed a fixer commit before losing its result.
    // Preserve that remote work and our new local fix without rewriting the PR.
    await this.shell(
      repo,
      `git fetch --no-tags origin ${quote(`refs/heads/${branch}`)}`,
    );
    await this.shell(
      repo,
      "git merge --no-edit -X ours -m 'fix: reconcile concurrent branch updates' FETCH_HEAD",
    );
    await this.shell(repo, command);
    return true;
  }
  get current() {
    return this.members.flatMap((m) => this.prs.get(m.name) ?? []);
  }
  get open() {
    return this.current.filter((pr) => pr.state !== 'merged');
  }
  get heads() {
    return Object.fromEntries(this.current.map((pr) => [pr.repo, pr.headSha]));
  }
  get revision() {
    return this.current.map((pr) => `${pr.repo}@${pr.headSha}`).join(',');
  }
  set(pr: ScmPr) {
    this.member(pr.repo);
    this.prs.set(pr.repo, pr);
  }
  async diff(previous: Record<string, string> = {}) {
    const parts: string[] = [];
    for (const member of this.members) {
      const before = previous[member.name];
      const range = before
        ? `${before}..HEAD`
        : `${this.base(member.name)}...HEAD`;
      const patch = await this.shell(
        member.name,
        `git diff --no-ext-diff --src-prefix=${quote(`a/${member.name}/`)} --dst-prefix=${quote(`b/${member.name}/`)} ${quote(range)}`,
      );
      if (patch) parts.push(patch);
    }
    return parts.join('\n');
  }
  async changedFiles() {
    const files: string[] = [];
    for (const member of this.members) {
      const paths = await this.shell(
        member.name,
        `git diff --name-only ${quote(`${this.base(member.name)}...HEAD`)}`,
      );
      files.push(
        ...paths
          .split('\n')
          .filter(Boolean)
          .map((path) => `${member.name}/${path}`),
      );
    }
    return files;
  }
  async sync(title: string, body: string) {
    for (const member of this.members) {
      const existing = this.prs.get(member.name);
      const dirty = await this.shell(member.name, 'git status --porcelain');
      if (dirty)
        throw new Error(
          `${member.name} has uncommitted work. Commit it before PR delivery.`,
        );
      const changed = await this.shell(
        member.name,
        `git diff --name-only ${quote(`${this.base(member.name)}...HEAD`)}`,
      );
      if (!changed && !existing) continue;
      let head = await this.shell(member.name, 'git rev-parse HEAD');
      if (existing?.state === 'merged') {
        if (head !== existing.headSha)
          throw new Error(
            `${member.name} changed after its PR merged. A new delivery is required.`,
          );
        continue;
      }
      const branch = await this.shell(member.name, 'git branch --show-current');
      if (branch !== this.ctx.branch)
        throw new Error(
          `${member.name} is not on the issue branch ${this.ctx.branch}.`,
        );
      const reconciled = await this.push(member.name, branch);
      // Older Runs recorded a second HEAD read even after a successful push.
      // Match its exact label so a companion repository's next exec is not
      // mistaken for that historical read during replay.
      if (
        reconciled ||
        (this.ctx.replaying &&
          this.ctx.replayStep === 'exec' &&
          this.ctx.replayLabel === `${member.name}: git rev-parse HEAD`)
      )
        head = await this.shell(member.name, 'git rev-parse HEAD');
      const pr = existing
        ? { ...existing, headSha: head }
        : requireRepositoryResult(
            await this.ctx.scm.openPr({
              repo: member.name,
              title,
              body,
              draft: true,
            }),
          );
      if (pr.repo !== member.name || pr.headSha !== head || pr.state !== 'open')
        throw new Error(
          `${member.name}: the open PR does not match the pushed revision.`,
        );
      this.set(pr);
    }
    if (!this.current.length)
      throw new Error('No changed repository has a PR to deliver.');
  }
  async markDraft(draft: boolean, body?: (pr: ScmPr) => string) {
    for (const pr of this.open) {
      const next = requireRepositoryResult(
        await this.ctx.scm.markDraft(
          pr,
          draft,
          body ? { body: body(pr) } : undefined,
        ),
      );
      if (next.headSha !== pr.headSha)
        throw new Error(
          `${pr.repo}: the PR changed during publication. Revalidate the new revision.`,
        );
      this.set(next);
    }
  }
  links() {
    return this.current
      .map(
        (pr) =>
          `- ${pr.repo}: ${pr.url} (${pr.headSha.slice(0, 12)}${pr.state === 'merged' ? ', merged' : ''})`,
      )
      .join('\n');
  }
}
