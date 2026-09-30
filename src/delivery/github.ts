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
export interface MergeRequest {
  number: number;
  head: string;
  requestedAt: number | null;
}
export interface CIAttempts {
  head: string;
  integration: string | null;
  identities: {
    source: string;
    id: number;
    sha: string;
    name: string;
    workflowRun: number | null;
    workflowAttempt: number | null;
  }[];
}
interface WorkflowRun {
  id: number;
  workflow_id: number;
  event: string;
  name: string;
  run_attempt: number;
  check_suite_id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}
export interface CIObservation {
  attempts: CIAttempts;
  head: string;
  integration: string | null;
  outcome: "pass" | "fail" | "pending";
  checks: {
    id: number;
    source: string;
    workflowRun: number | null;
    workflowAttempt: number | null;
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
  private async collect(repository: string, pr: PullRequest, cwd: string) {
    const checks: CIObservation["checks"] = [];
    const identities: CIAttempts["identities"] = [];
    for (const sha of [
      ...new Set([pr.head, ...(pr.integration ? [pr.integration] : [])]),
    ]) {
      const jobs = await this.json(
        repository,
        `commits/${sha}/check-runs?filter=latest&per_page=100`,
        cwd,
      );
      if (jobs.total_count > 100)
        throw new Error(
          "CI check pagination required; refusing partial evidence",
        );
      const workflows = await this.json(
        repository,
        `actions/runs?head_sha=${sha}&per_page=100`,
        cwd,
      );
      if (workflows.total_count > 100)
        throw new Error(
          "CI workflow pagination required; refusing partial evidence",
        );
      const latest = new Map<string, WorkflowRun>();
      for (const workflow of workflows.workflow_runs as WorkflowRun[]) {
        const key = `${workflow.workflow_id}/${workflow.event}`;
        if (!latest.has(key) || latest.get(key)!.id < workflow.id)
          latest.set(key, workflow);
      }
      for (const workflow of latest.values()) {
        if (
          !Number.isSafeInteger(workflow.id) ||
          !Number.isSafeInteger(workflow.run_attempt)
        )
          throw new Error("CI workflow attempt identity unavailable");
        const binding = {
          source: "workflow",
          id: workflow.id,
          name: workflow.name,
          sha,
          workflowRun: workflow.id,
          workflowAttempt: workflow.run_attempt,
        };
        identities.push(binding);
        checks.push({
          ...binding,
          status: workflow.status,
          conclusion: workflow.conclusion,
          url: workflow.html_url,
        });
      }
      for (const j of jobs.check_runs) {
        if (!Number.isSafeInteger(j.id))
          throw new Error("CI check-run identity unavailable");
        const workflow = [...latest.values()].find(
          (w) => w.check_suite_id === j.check_suite?.id,
        );
        const binding = {
          source: "check-run",
          id: j.id,
          name: j.name,
          sha,
          workflowRun: workflow?.id ?? null,
          workflowAttempt: workflow?.run_attempt ?? null,
        };
        identities.push(binding);
        checks.push({
          ...binding,
          status: j.status,
          conclusion: j.conclusion,
          url: j.html_url ?? "",
        });
      }
      const statuses = await this.json(
        repository,
        `commits/${sha}/status?per_page=100`,
        cwd,
      );
      if (statuses.total_count > 100)
        throw new Error(
          "CI status pagination required; refusing partial evidence",
        );
      for (const s of statuses.statuses) {
        if (!Number.isSafeInteger(s.id))
          throw new Error("CI status identity unavailable");
        const binding = {
          source: "status",
          id: s.id,
          name: s.context,
          sha,
          workflowRun: null,
          workflowAttempt: null,
        };
        identities.push(binding);
        checks.push({
          ...binding,
          status: s.state === "pending" ? "in_progress" : "completed",
          conclusion: s.state === "success" ? "success" : s.state,
          url: s.target_url ?? "",
        });
      }
    }
    const order = (a: unknown, b: unknown) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b));
    identities.sort(order);
    checks.sort(order);
    return {
      attempts: { head: pr.head, integration: pr.integration, identities },
      checks,
    };
  }
  /** Discovery supplies upstream attempt IDs; discard result data until the host begins its collector. */
  async attempts(
    repository: string,
    pr: PullRequest,
    cwd: string,
  ): Promise<CIAttempts> {
    return (await this.collect(repository, pr, cwd)).attempts;
  }
  async observe(
    repository: string,
    pr: PullRequest,
    required: string[],
    cwd: string,
  ): Promise<CIObservation> {
    const { attempts, checks } = await this.collect(repository, pr, cwd);
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
      attempts,
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
    return {
      number: pr.number,
      head: expected,
      requestedAt: Date.now(),
    } satisfies MergeRequest;
  }
}
