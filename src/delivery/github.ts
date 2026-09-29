import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type Execute = (
  file: string,
  args: string[],
  cwd: string,
) => Promise<string>;
export const execute: Execute = async (file, args, cwd) => {
  const { stdout } = await exec(file, args, {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};
export interface PullRequest {
  number: number;
  url: string;
  head: string;
  base: string;
  integration: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeCommit: string | null;
}
export interface CIObservation {
  head: string;
  integration: string | null;
  outcome: "pass" | "fail" | "pending";
  checks: {
    name: string;
    sha: string;
    status: string;
    conclusion: string | null;
    url: string;
  }[];
  observedAt: number;
}
export class GitHub {
  constructor(readonly run: Execute = execute) {}
  async json(repository: string, path: string, cwd: string) {
    return JSON.parse(
      await this.run("gh", ["api", `repos/${repository}/${path}`], cwd),
    );
  }
  async pull(
    repository: string,
    number: number,
    cwd: string,
  ): Promise<PullRequest> {
    const p = await this.json(repository, `pulls/${number}`, cwd);
    return {
      number: p.number,
      url: p.html_url,
      head: p.head.sha,
      base: p.base.sha,
      integration: p.merge_commit_sha ?? null,
      state: p.state,
      draft: p.draft,
      merged: p.merged,
      mergeCommit: p.merged ? p.merge_commit_sha : null,
    };
  }
  async draft(
    repository: string,
    branch: string,
    base: string,
    head: string,
    cwd: string,
    title: string,
    beforeWrite: () => void = () => {},
  ): Promise<PullRequest> {
    const origin = `https://github.com/${repository}.git`;
    beforeWrite();
    await this.run(
      "git",
      ["push", origin, `${head}:refs/heads/${branch}`],
      cwd,
    );
    beforeWrite();
    const url = await this.run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        base,
        "--head",
        branch,
        "--draft",
        "--title",
        title.slice(0, 180),
        "--body",
        "Created by Rocky. Local checks and independent review evidence are retained in the local run. Human exact-head approval is required before merge.",
      ],
      cwd,
    );
    const number = Number(/\/pull\/(\d+)\s*$/.exec(url)?.[1]);
    if (!number)
      throw new Error(
        "GitHub returned no pull request number; reconcile before retrying",
      );
    const pr = await this.pull(repository, number, cwd);
    if (pr.head !== head)
      throw new Error("Created PR head differs from the verified commit");
    return pr;
  }
  async observe(
    repository: string,
    pr: PullRequest,
    required: string[],
    cwd: string,
  ): Promise<CIObservation> {
    const checks: CIObservation["checks"] = [];
    for (const sha of [
      ...new Set([pr.head, ...(pr.integration ? [pr.integration] : [])]),
    ]) {
      const jobs = await this.json(
        repository,
        `commits/${sha}/check-runs?per_page=100`,
        cwd,
      );
      if (jobs.total_count > 100)
        throw new Error(
          "CI check pagination required; refusing partial evidence",
        );
      for (const j of jobs.check_runs)
        checks.push({
          name: j.name,
          sha,
          status: j.status,
          conclusion: j.conclusion,
          url: j.html_url ?? "",
        });
      const statuses = await this.json(
        repository,
        `commits/${sha}/status?per_page=100`,
        cwd,
      );
      if (statuses.total_count > 100)
        throw new Error(
          "CI status pagination required; refusing partial evidence",
        );
      for (const s of statuses.statuses)
        checks.push({
          name: s.context,
          sha,
          status: s.state === "pending" ? "in_progress" : "completed",
          conclusion: s.state === "success" ? "success" : s.state,
          url: s.target_url ?? "",
        });
    }
    const current = checks.filter((c) => c.sha === (pr.integration ?? pr.head));
    const failed = checks.some(
      (c) =>
        c.status === "completed" &&
        !["success", "neutral", "skipped"].includes(c.conclusion ?? ""),
    );
    const complete =
      pr.integration !== null &&
      required.every((name) =>
        current.some(
          (c) =>
            c.name === name &&
            c.status === "completed" &&
            c.conclusion === "success",
        ),
      ) &&
      checks.every((c) => c.status === "completed");
    return {
      head: pr.head,
      integration: pr.integration,
      outcome: failed ? "fail" : complete ? "pass" : "pending",
      checks,
      observedAt: Date.now(),
    };
  }
  async ready(repository: string, pr: PullRequest, cwd: string) {
    await this.run(
      "gh",
      ["pr", "ready", String(pr.number), "--repo", repository],
      cwd,
    );
    return this.pull(repository, pr.number, cwd);
  }
  async merge(
    repository: string,
    pr: PullRequest,
    expected: string,
    cwd: string,
  ) {
    await this.run(
      "gh",
      [
        "pr",
        "merge",
        String(pr.number),
        "--repo",
        repository,
        "--squash",
        "--match-head-commit",
        expected,
      ],
      cwd,
    );
    const result = await this.pull(repository, pr.number, cwd);
    if (!result.merged || !result.mergeCommit)
      throw new Error("Merge requested; GitHub has not confirmed a merge");
    return result;
  }
}
