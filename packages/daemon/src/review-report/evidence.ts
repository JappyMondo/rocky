import type { JournalEntry } from '../run/journal.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ReportPullRequest } from './schema.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Link only PRs returned by SCM; prose from agents is not a delivery receipt. */
export function recapPullRequests(entries: readonly JournalEntry[]) {
  const prs = new Map<string, typeof ReportPullRequest._output>();
  for (const entry of entries) {
    if (entry.status !== 'done' || !entry.step.startsWith('scm.')) continue;
    const result = record(entry.result);
    const parsed = ReportPullRequest.safeParse(result.pr ?? result);
    if (parsed.success) prs.set(parsed.data.repo, parsed.data);
  }
  return [...prs.values()];
}

/** Read each member independently so a primary PR cannot imply companion delivery. */
export async function recapRepositoryEvidence(input: {
  workspaceDir: string;
  branch: string;
  primaryRepo?: string;
  members: readonly { name: string; path: string; baseBranch: string }[];
  env?: NodeJS.ProcessEnv;
}) {
  const execute = promisify(execFile);
  return Promise.all(
    input.members.map(async (member) => {
      const git = async (...args: string[]) =>
        (
          await execute('git', args, {
            cwd: join(input.workspaceDir, member.path),
            env: input.env,
            timeout: 30000,
            maxBuffer: 8_000_000,
          })
        ).stdout.trim();
      try {
        const [headSha, status, remote, changedFiles, diff] = await Promise.all(
          [
            git('rev-parse', 'HEAD'),
            git('status', '--porcelain'),
            git('ls-remote', 'origin', `refs/heads/${input.branch}`),
            git('diff', '--name-status', `origin/${member.baseBranch}...HEAD`),
            member.name === input.primaryRepo
              ? Promise.resolve('See the immutable primary diff.')
              : git('diff', `origin/${member.baseBranch}...HEAD`),
          ],
        );
        return {
          repository: member.name,
          headSha,
          clean: !status,
          remoteBranchHead: remote.split(/\s/)[0] || null,
          baseRef: `origin/${member.baseBranch}`,
          changedFiles,
          diff: diff.slice(0, 30000),
          checkedAt: new Date().toISOString(),
          note: 'Remote branch presence does not establish a PR. Use recorded PR receipts; otherwise delivery is unverified.',
        };
      } catch {
        return {
          repository: member.name,
          unavailable:
            'Could not inspect local and remote repository state. Delivery is unverified.',
        };
      }
    }),
  );
}

/** Preserve provenance: an agent's summary is never promoted to a check receipt. */
export function recapWorkflowEvidence(
  entries: readonly JournalEntry[],
  headSha?: string,
) {
  const completed = entries.filter(
    (entry) =>
      entry.status === 'done' && !entry.step.startsWith('reviewReport.'),
  );
  const scopeDecision = completed
    .map((entry) => record(entry.result))
    .findLast(
      (result) =>
        result.status === 'clear' && Array.isArray(result.acceptanceCriteria),
    );
  const receipts = completed
    .filter((entry) => entry.step !== 'agent')
    .flatMap((entry) => {
      const result = record(entry.result);
      const kind =
        entry.step === 'linear.comment' && typeof result.id === 'string'
          ? 'linear-comment'
          : entry.label === 'Confirm delivered issue state' &&
              typeof result.state === 'string'
            ? 'linear-state'
            : typeof result.exitCode === 'number'
              ? 'command'
              : typeof result.headSha === 'string' &&
                  ['passed', 'failed', 'pending', 'not-configured'].includes(
                    String(result.status),
                  )
                ? 'ci'
                : typeof result.url === 'string' &&
                    typeof result.number === 'number'
                  ? 'pull-request'
                  : undefined;
      if (!kind) return [];
      // Shell steps include git plumbing; retain checks with output and failed commands.
      if (
        kind === 'command' &&
        result.exitCode === 0 &&
        !result.stdout &&
        !result.stderr
      )
        return [];
      const { stdout, stderr, ...rest } = result;
      return [
        {
          stepKey: String(entry.seq),
          label: entry.label ?? entry.step,
          at: entry.startedAt,
          kind,
          repository:
            typeof result.repo === 'string'
              ? result.repo
              : (/^scm\.[^:]+:([^:]+):/.exec(entry.step)?.[1] ?? null),
          revision: typeof result.headSha === 'string' ? result.headSha : null,
          currentRevision:
            typeof result.headSha === 'string' && !!headSha
              ? result.headSha === headSha
              : null,
          result: {
            ...rest,
            ...(typeof stdout === 'string'
              ? { stdout: stdout.slice(-12000) }
              : {}),
            ...(typeof stderr === 'string'
              ? { stderr: stderr.slice(-6000) }
              : {}),
          },
        },
      ];
    });
  const agentReports = completed
    .filter(
      (entry) => entry.step === 'agent' && !entry.label?.startsWith('Recap '),
    )
    .flatMap((entry) => {
      const result = record(entry.result);
      return typeof result.summary === 'string'
        ? [
            {
              stepKey: String(entry.seq),
              label: entry.label,
              summary: result.summary,
              evidenceType: 'agent-reported; not an execution receipt',
            },
          ]
        : [];
    })
    .slice(-8);
  return { scopeDecision, receipts: receipts.slice(-30), agentReports };
}
