import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ensureClone } from '../repos/clone.js';
import type { RepoContext, RepoRef } from '../repos/context.js';
import { canonicalRemote, type RepositoryProfile } from '../config/profiles.js';
import { WorkflowLoadError, type TriggerSelector } from './loading/loader.js';
import { loadMcpRuntime, type McpRuntime } from './mcp-contract.js';
import {
  validateSnapshotTriggers,
  type SnapshotValidationOptions,
} from './loading/validate.js';

export { resolveSnapshotTrigger } from './loading/loader.js';

const exec = promisify(execFile);

export interface PreparedWorkflowSnapshot {
  sourceCommit: string;
  snapshotDir: string;
  triggers: TriggerSelector[];
}

export interface SnapshotPreparationOptions extends SnapshotValidationOptions {
  /** NG-599 supplies the parser; tests inject its public consumer contract. */
  mcp?: Pick<McpRuntime, 'readMcpConfig'>;
}

/**
 * Materialize the complete local profile into immutable Run bytes. The target
 * repository contributes its revision and workspace only; it never supplies a
 * workflow, prompt, MCP declaration, or grant at admission time.
 */
export async function prepareProfileSnapshot(
  context: RepoContext,
  lead: RepoRef,
  profile: RepositoryProfile,
  options: SnapshotPreparationOptions = {},
): Promise<PreparedWorkflowSnapshot> {
  options.signal?.throwIfAborted();
  if (profile.remote !== canonicalRemote(lead.url)) {
    throw new WorkflowLoadError(
      'invalid-workflow',
      `profiles/${profile.id}.json`,
      `belongs to ${profile.remote}, not ${canonicalRemote(lead.url)}`,
      'Assign a local profile for this exact remote with `rocky repo profile import`, then re-delegate.',
    );
  }
  const clone = await ensureClone(context, lead);
  const staging = join(context.paths.root, 'snapshots');
  await mkdir(staging, { recursive: true });
  const snapshotDir = await mkdtemp(join(staging, '.profile-'));
  let validationDir: string | undefined;
  try {
    const sourceCommit = await context.mutex.run(lead.name, async () => {
      const result = await exec(
        'git',
        ['rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'],
        {
          cwd: clone.dir,
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60_000,
          signal: options.signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );
      return result.stdout.toString('ascii').trim();
    });
    await mkdir(join(snapshotDir, 'agents'), { recursive: true });
    await mkdir(join(snapshotDir, 'rules'), { recursive: true });
    await writeFile(join(snapshotDir, 'workflow.ts'), profile.workflow.source);
    await writeFile(join(snapshotDir, 'mcp.json'), JSON.stringify(profile.mcp));
    await writeFile(join(snapshotDir, 'profile.json'), JSON.stringify(profile));
    await writeFile(join(snapshotDir, 'schemas.txt'), profile.schemas);
    await Promise.all([
      ...Object.entries(profile.prompts).map(([name, prompt]) =>
        writeFile(join(snapshotDir, 'agents', `${name}.md`), prompt),
      ),
      ...Object.entries(profile.rules).map(([name, rule]) =>
        writeFile(join(snapshotDir, 'rules', `${name}.md`), rule),
      ),
    ]);
    const mcp = options.mcp ?? (await loadMcpRuntime());
    await mcp.readMcpConfig(join(snapshotDir, 'mcp.json'));
    validationDir = await mkdtemp(join(staging, '.validate-'));
    await cp(snapshotDir, validationDir, { recursive: true });
    const triggers = await validateSnapshotTriggers(validationDir, options);
    return { sourceCommit, snapshotDir, triggers };
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true });
    if (error instanceof WorkflowLoadError) throw error;
    throw new WorkflowLoadError(
      'invalid-workflow',
      `profiles/${profile.id}.json`,
      error instanceof Error ? error.message : String(error),
      'Fix this local profile and retry; repository .rocky files are intentionally ignored.',
    );
  } finally {
    if (validationDir)
      await rm(validationDir, { recursive: true, force: true });
  }
}

export async function prepareWorkflowSnapshot(
  context: RepoContext,
  lead: RepoRef,
  options: SnapshotPreparationOptions = {},
): Promise<PreparedWorkflowSnapshot> {
  options.signal?.throwIfAborted();
  const clone = await ensureClone(context, lead);
  options.signal?.throwIfAborted();
  const staging = join(context.paths.root, 'snapshots');
  await mkdir(staging, { recursive: true });
  const snapshotDir = await mkdtemp(join(staging, '.snapshot-'));
  let validationDir: string | undefined;
  try {
    const sourceCommit = await context.mutex.run(lead.name, async () => {
      options.signal?.throwIfAborted();
      const git = async (...args: string[]) =>
        (
          await exec('git', args, {
            cwd: clone.dir,
            encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60_000,
            signal: options.signal,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          })
        ).stdout;
      // Pin the remote's default branch once, not the issue branch or live files.
      const commit = (
        await git('rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}')
      )
        .toString('ascii')
        .trim();
      const tree = await git('ls-tree', '-r', '-z', commit, '--', '.rocky');
      if (tree.length === 0) {
        throw new WorkflowLoadError(
          'onboarding-required',
          `${lead.name}/.rocky`,
          `missing on the default branch at ${commit}`,
          'Run Onboarding to seed .rocky/, merge its PR, then re-delegate.',
        );
      }
      for (const record of new TextDecoder('utf-8', { fatal: true })
        .decode(tree)
        .split('\0')) {
        if (!record) continue;
        const tab = record.indexOf('\t');
        const [mode, type, object] = record.slice(0, tab).split(' ');
        const path = record.slice(tab + 1);
        if (
          !path.startsWith('.rocky/') ||
          path
            .split('/')
            .some((part) => part === '..' || part === '.' || !part) ||
          type !== 'blob' ||
          (mode !== '100644' && mode !== '100755')
        ) {
          throw new WorkflowLoadError(
            'invalid-workflow',
            `${lead.name}/${path}`,
            'snapshot requires regular files inside .rocky/; symlinks and gitlinks are not supported',
            'Replace this entry with a regular file inside .rocky/ and retry.',
          );
        }
        const destination = join(snapshotDir, path.slice('.rocky/'.length));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await git('cat-file', 'blob', object));
        await chmod(destination, mode === '100755' ? 0o755 : 0o644);
      }
      return commit;
    });
    try {
      const mcp = options.mcp ?? (await loadMcpRuntime());
      await mcp.readMcpConfig(join(snapshotDir, 'mcp.json'));
    } catch (error) {
      throw new WorkflowLoadError(
        'invalid-workflow',
        '.rocky/mcp.json',
        error instanceof Error ? error.message : String(error),
        'Fix .rocky/mcp.json using the mcpServers declaration format and retry.',
      );
    }
    // Top-level code may write files: validation must not mutate the bytes
    // admission will publish. No runtime artifacts are added to the snapshot.
    validationDir = await mkdtemp(join(staging, '.validate-'));
    await cp(snapshotDir, validationDir, { recursive: true });
    const triggers = await validateSnapshotTriggers(validationDir, options);
    return { sourceCommit, snapshotDir, triggers };
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true });
    options.signal?.throwIfAborted();
    if (error instanceof WorkflowLoadError) throw error;
    throw new WorkflowLoadError(
      'invalid-workflow',
      `${lead.name}/.rocky/workflow.ts`,
      error instanceof Error ? error.message : String(error),
      'Check the lead repo default branch and its committed .rocky/ files, fix the named error, then retry.',
    );
  } finally {
    if (validationDir)
      await rm(validationDir, { recursive: true, force: true });
  }
}
