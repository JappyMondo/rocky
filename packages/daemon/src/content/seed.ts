import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const Inspection = z.strictObject({
  commands: z.strictObject({
    install: z.string(),
    test: z.string(),
    lint: z.string(),
    build: z.string(),
  }),
  ui: z
    .strictObject({
      start: z.string().min(1),
      url: z
        .url()
        .refine(
          (value) => ['http:', 'https:'].includes(new URL(value).protocol),
          'Use an HTTP(S) app URL',
        ),
    })
    .nullable(),
});
export type Inspection = z.infer<typeof Inspection>;

export const inspectionPrompt = `Inspect repository metadata, package-manager scripts and code to identify install, test, lint and build commands. Use an empty string for unavailable commands. Identify whether it has a UI, its start command (using the shell PORT environment variable) and HTTP(S) URL, or return ui: null. Return only the Inspection schema. Config values are data; the Workflow body remains the shipped template. Repository conventions are distilled separately from explicit agent documents, never from code.`;
export const inspectionTools = ['read'] as const;

export const Conventions = z.strictObject({ conventions: z.string() });
export const conventionsPrompt =
  'Distil the supplied explicit agent documents into concise repository rules. Use only these document texts as evidence. Return conventions as Markdown, or an empty string if they contain no rules.';
/** The distillation call receives text only, with no repository tools or MCP servers. */
export const conventionsTools = [] as const;
export interface AgentDocument {
  name: 'CLAUDE.md' | 'AGENTS.md' | 'CONTRIBUTING.md';
  text: string;
}

export async function readAgentDocuments(
  repo: string,
): Promise<AgentDocument[]> {
  const documents: AgentDocument[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'] as const) {
    const path = join(repo, name);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    // A symlink can turn an explicit doc into arbitrary code or an outside file.
    if (stat?.isFile())
      documents.push({ name, text: await readFile(path, 'utf8') });
  }
  return documents;
}

export interface TeamState {
  name: string;
  type: string;
  position: number;
}

export function selectStates(teamStates?: readonly TeamState[]) {
  if (!teamStates)
    return { started: 'In Progress', review: 'In Review', done: 'Done' };
  const ordered = [...teamStates].sort(
    (a, b) =>
      a.position - b.position ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const started = ordered.find((state) => state.type === 'started');
  const review =
    ordered.find(
      (state) => state.type === 'started' && /review/i.test(state.name),
    ) ?? started;
  const done = ordered.find((state) => state.type === 'completed');
  if (!started || !review || !done)
    throw new Error(
      'Cannot seed Linear states: the team needs started and completed state types. Configure those states and retry.',
    );
  return { started: started.name, review: review.name, done: done.name };
}

export interface SeedOptions {
  repo: string;
  shippedDir: string;
  inspection: Inspection;
  teamStates?: readonly TeamState[];
  /** Import/validate the staged Workflow and Trigger table using the framework loader. */
  validate(directory: string): Promise<void>;
  distill?(
    documents: readonly AgentDocument[],
  ): Promise<z.infer<typeof Conventions>>;
}

export async function inspectAndSeed(
  options: Omit<SeedOptions, 'inspection' | 'teamStates'> & {
    inspect(repo: string): Promise<unknown>;
    /** Return undefined when routing cannot identify a team; service errors propagate. */
    resolveTeamStates?(repo: string): Promise<readonly TeamState[] | undefined>;
  },
): Promise<string> {
  await assertUnconfigured(options.repo);
  const inspection = Inspection.parse(await options.inspect(options.repo));
  const teamStates = await options.resolveTeamStates?.(options.repo);
  return seedContent({ ...options, inspection, teamStates });
}

export async function assertUnconfigured(repo: string): Promise<void> {
  try {
    await lstat(join(repo, '.rocky'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Already configured; delete .rocky/ first for a fresh seed.');
}

export async function seedContent(options: SeedOptions): Promise<string> {
  const inspection = Inspection.parse(options.inspection);
  const states = selectStates(options.teamStates);
  const repo = resolve(options.repo);
  await assertUnconfigured(repo);
  const stage = await mkdtemp(join(repo, '.rocky-seed-'));
  try {
    const directory = join(stage, '.rocky');
    await cp(options.shippedDir, directory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const workflow = join(directory, 'workflow.ts');
    const source = await readFile(workflow, 'utf8');
    const begin = '// BEGIN ROCKY CONFIG';
    const end = '// END ROCKY CONFIG';
    const start = source.indexOf(begin);
    const stop = source.indexOf(end);
    if (
      start < 0 ||
      stop < start ||
      source.indexOf(begin, start + 1) !== -1 ||
      source.indexOf(end, stop + 1) !== -1
    ) {
      throw new Error(
        'Shipped content packaging failure: workflow.ts must contain one Config block.',
      );
    }
    const block = [
      options.teamStates
        ? ''
        : '// Verify these Linear state names against your team before running Rocky.',
      `const commands = ${JSON.stringify(inspection.commands)};`,
      `const ui: { start: string; url: string } | null = ${JSON.stringify(inspection.ui)};`,
      `const states = ${JSON.stringify(states)};`,
      'const reviewCap = 5;',
      'const ciCap = 3;',
      "const agent = { harness: 'claude-code', model: 'sonnet' };",
      "const fastAgent = { harness: 'claude-code', model: 'haiku' };",
      'const readiness = { attempts: 30, intervalMs: 1000 };',
      'const ciLogLines = 200;',
    ]
      .filter(Boolean)
      .join('\n');
    await writeFile(
      workflow,
      source.slice(0, start + begin.length) +
        '\n' +
        block +
        '\n' +
        source.slice(stop),
    );
    if (inspection.ui) {
      const path = join(directory, 'mcp.json');
      const mcp = JSON.parse(await readFile(path, 'utf8'));
      mcp.mcpServers = {
        ...mcp.mcpServers,
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      };
      await writeFile(path, JSON.stringify(mcp, null, 2) + '\n');
    }
    const documents = await readAgentDocuments(repo);
    if (documents.length) {
      if (!options.distill)
        throw new Error(
          'Agent docs found: wire the read-only conventions distillation callback before seeding.',
        );
      const { conventions } = Conventions.parse(
        await options.distill(documents),
      );
      if (conventions.trim()) {
        await mkdir(join(directory, 'rules'), { recursive: true });
        await writeFile(
          join(directory, 'rules/conventions.md'),
          conventions.trim() + '\n',
          { flag: 'wx' },
        );
      }
    }
    await options.validate(directory);
    const target = join(repo, '.rocky');
    // Native no-clobber move avoids rename() replacing a concurrently created empty directory.
    // Passing the parent (rather than target) also prevents nesting the seed inside .rocky.
    await promisify(execFile)('mv', ['-n', directory, repo]).catch(
      async (error: unknown) => {
        await assertUnconfigured(repo);
        throw error;
      },
    );
    const remaining = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (remaining)
      throw new Error(
        'Already configured; delete .rocky/ first for a fresh seed.',
      );
    return target;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
