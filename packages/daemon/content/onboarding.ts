import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCallOpts, ScmRefusal, WorkflowContext } from '@rocky/sdk';
import { CiFix } from './.rocky/schemas.js';
import {
  Conventions,
  Inspection,
  conventionsPrompt,
  inspectionPrompt,
  readAgentDocuments,
  seedContent,
  type TeamState,
} from '../src/content/seed.js';

export interface OnboardingServices {
  /** Lead working tree and immutable shipped tree chosen by admission. */
  repo: string;
  shippedDir: string;
  teamStates(): Promise<readonly TeamState[]>;
  /** The same loader validation used for an ordinary Workflow import. */
  validate(directory: string): Promise<void>;
}

function requireScm<T>(result: T | ScmRefusal): T {
  if (result && typeof result === 'object' && 'refused' in result)
    throw new Error(`${result.message}\n${result.fix}`);
  return result as T;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function exists(directory: string) {
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat && !stat.isDirectory())
    throw new Error(
      'The seed target .rocky must be a real directory, not a file or symlink.',
    );
  return !!stat;
}

async function immutableFiles(
  directory: string,
  relative = '',
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (
    await readdir(join(directory, relative), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(relative, entry.name);
    if (entry.isDirectory())
      Object.assign(files, await immutableFiles(directory, path));
    else if (entry.isFile()) {
      const text = await readFile(join(directory, path), 'utf8');
      files[path] =
        path === 'workflow.ts'
          ? text.replace(
              /\/\/ BEGIN ROCKY CONFIG[\s\S]*?\/\/ END ROCKY CONFIG/,
              '',
            )
          : text;
    } else throw new Error(`Unsupported seed file: ${path}`);
  }
  return files;
}

/** The missing-lead binding runs this with the internal .rocky/ as its snapshot. */
export function createOnboarding(services: OnboardingServices) {
  return async (ctx: WorkflowContext) => {
    // First-run onboarding must use the harness already authenticated on this
    // machine. OpenCode owns its provider/model selection, so leave `model`
    // unset instead of imposing a Claude-only default before Rocky can seed
    // the repository's own configuration.
    const model = { harness: 'opencode' };
    const edit: AgentCallOpts = { ...model, tools: ['read', 'edit', 'bash'] };
    const directory = join(services.repo, '.rocky');
    const shell = async (command: string) => {
      // Workflow context commands normally start at the Run workspace, which
      // contains every registered clone. Onboarding changes only its lead, so
      // every git operation must explicitly enter that owned clone.
      const result = await ctx.exec(
        `cd -- ${quote(services.repo)} && ${command}`,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `Onboarding command failed: ${command}\n${result.stderr}`,
        );
      return result.stdout.trim();
    };
    ctx.stage('Onboarding');
    const existing = await ctx.step('inspect seed presence', () =>
      exists(directory),
    );
    if (!existing) {
      const inspected = await ctx.agent(
        { prompt: inspectionPrompt },
        {
          ...model,
          tools: ['read'],
          label: 'inspect repository',
          schema: Inspection,
        },
      );
      const documents = await ctx.step('read explicit agent docs', () =>
        readAgentDocuments(services.repo),
      );
      const conventions = documents.length
        ? await ctx.agent(
            { prompt: conventionsPrompt },
            {
              ...model,
              tools: [],
              label: 'distil explicit agent docs',
              input: { documents },
              schema: Conventions,
            },
          )
        : { conventions: '' };
      const teamStates = await ctx.step(
        'read issue team states',
        services.teamStates,
      );
      await ctx.step('install seed', async () => {
        // A crash after the atomic installation adopts the tree instead of overwriting it.
        if (await exists(directory)) await services.validate(directory);
        else
          await seedContent({
            repo: services.repo,
            shippedDir: services.shippedDir,
            inspection: { commands: inspected.commands, ui: inspected.ui },
            teamStates,
            validate: services.validate,
            distill: async () => ({ conventions: conventions.conventions }),
          });
        return null;
      });
    } else {
      await ctx.step('validate adopted seed', async () => {
        await services.validate(directory);
        return null;
      });
    }
    const baseline = await ctx.step('record seed boundary', () =>
      immutableFiles(directory),
    );
    const validateSeed = () =>
      ctx.step('validate repaired seed', async () => {
        if (
          JSON.stringify(await immutableFiles(directory)) !==
          JSON.stringify(baseline)
        )
          throw new Error(
            'Repair changed the seed outside its Config block. Restore the seed content and repair only the integration configuration.',
          );
        await services.validate(directory);
        return null;
      });
    await shell(
      `git add -- .rocky && (git diff --cached --quiet -- .rocky || git commit --only -m ${quote('Seed Rocky Workflow')} -m ${quote(ctx.issue.identifier)} -- .rocky)`,
    );
    await shell('git push origin HEAD');
    let pr = requireScm(
      await ctx.scm.openPr({
        title: 'Seed Rocky Workflow',
        body: `Configure Rocky for this repository.\n\n${ctx.issue.url}\n\nMerge this seed, then re-delegate the issue.`,
        draft: false,
      }),
    );
    if (pr.state === 'merged') {
      await ctx.post(
        `The seed PR ${pr.url} is already merged. Re-delegate to run this repository's Workflow.`,
      );
      return 'completed' as const;
    }
    const update = requireScm(await ctx.scm.updateBranch(pr));
    pr = update.pr;
    if (update.status !== 'clean') {
      await shell('git fetch origin');
      const merge = await ctx.exec(
        `cd -- ${quote(services.repo)} && git merge --no-edit -- ${quote(`refs/remotes/origin/${update.status === 'updated' ? pr.sourceBranch : pr.baseBranch}`)}`,
      );
      const conflicts = await shell('git diff --name-only --diff-filter=U');
      if (update.status === 'conflict' || conflicts)
        await ctx.agent('merger', {
          ...edit,
          input: { issue: ctx.issue, update, conflicts, seedOnly: true },
        });
      else if (merge.exitCode !== 0)
        throw new Error(`Could not refresh the seed branch: ${merge.stderr}`);
      await validateSeed();
      await shell('git push origin HEAD');
      pr = { ...pr, headSha: await shell('git rev-parse HEAD') };
    }
    let ci = requireScm(await ctx.scm.waitForCi(pr, { logTailLines: 200 }));
    if (ci.headSha !== pr.headSha)
      throw new Error(
        'Seed CI returned another head; refresh the branch and retry.',
      );
    for (let attempt = 1; ci.status === 'failed' && attempt <= 3; attempt++) {
      const fix = await ctx.agent('ci-fixer', {
        ...edit,
        label: `seed ci-fixer ${attempt}/3`,
        input: { issue: ctx.issue, failedJobs: ci.failedJobs, seedOnly: true },
        schema: CiFix,
      });
      if (fix.action === 'unresolved') break;
      if (fix.action === 'retry') requireScm(await ctx.scm.retryFailedJobs(pr));
      else {
        await validateSeed();
        await shell('git push origin HEAD');
        pr = { ...pr, headSha: await shell('git rev-parse HEAD') };
      }
      ci = requireScm(await ctx.scm.waitForCi(pr, { logTailLines: 200 }));
      if (ci.headSha !== pr.headSha)
        throw new Error(
          'Seed CI returned another head; refresh the branch and retry.',
        );
    }
    if (ci.status !== 'passed') {
      await ctx.post(
        `Seed PR ${pr.url} remains open. CI did not pass within the repair cap:\n${JSON.stringify(ci.failedJobs, null, 2)}\nResolve the named failures, merge the seed, then re-delegate.`,
      );
      return 'exhausted' as const;
    }
    await ctx.post(
      `This repo has no .rocky/, so I cannot work the ticket yet. I have opened PR #${pr.number} seeding it: ${pr.url}\nMerge it, then re-delegate.`,
    );
    return 'completed' as const;
  };
}
