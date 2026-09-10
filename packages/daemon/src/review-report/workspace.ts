import { git } from '../repos/git.js';

/** Read actual git state, never an Agent's claim that it committed or pushed. */
export async function reviewRevision(
  cwd: string,
  branch: string,
  baseBranch: string,
  expectedHead?: string,
) {
  const run = async (...args: string[]) => (await git(args, { cwd })).stdout;
  const current = await run('branch', '--show-current');
  if (current !== branch)
    throw new Error(
      `Expected issue branch ${branch}, found ${current}. Restore the Run workspace before opening a PR.`,
    );
  if (await run('status', '--porcelain'))
    throw new Error(
      'The Run workspace contains uncommitted changes. Commit the intended work before opening or marking a PR ready.',
    );
  const headSha = await run('rev-parse', 'HEAD');
  const baseSha = await run('merge-base', `origin/${baseBranch}`, headSha);
  const diff = await run(
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    `${baseSha}...${headSha}`,
    '--',
  );
  if (!diff.trim())
    throw new Error(
      `No committed changes in ${branch} against ${baseBranch}. Refusing an empty PR; verify the Agent worked in the Run workspace and intended repository.`,
    );
  const remote = await run(
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branch}`,
  );
  if (remote.split(/\s+/)[0] !== headSha)
    throw new Error(
      'The remote issue branch does not contain the local commit. Push the Run branch before opening or marking a PR ready.',
    );
  if (expectedHead && expectedHead !== headSha)
    throw new Error(
      'The PR head does not match the local work. Refresh the PR and validate the pushed revision.',
    );
  return { headSha, baseSha, diff };
}
