/**
 * `run.json` is a pure cache of the journal (NG-574 §4–§5): the terminal
 * `$end` entry is what makes the journal self-describing, so when the header
 * and the journal disagree the journal wins and the header is rebuilt.
 *
 * The issue snapshot and the branch are the exception — they live only here,
 * which is why a Run directory without a readable header is unusable rather
 * than merely stale.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import {
  RUN_HEADER_VERSION,
  loadRunHeader,
  newRunHeader,
  readRunHeader,
  readRunIndex,
  runEndFor,
  writeRunHeader,
  RunHeaderError,
  type RunHeader,
} from './header.js';
import { END_STEP, JOURNAL_FORMAT_VERSION, appendEntry } from './journal.js';

const POSIX = process.platform !== 'win32';

let root: string;
let paths: RockyPaths;
let warnings: string[];
const warn = (message: string) => warnings.push(message);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-run-'));
  paths = rockyPaths(root);
  warnings = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const issue = {
  identifier: 'NG-601',
  title: 'Journal and replay',
  description: 'The Run’s only durable truth.',
  url: 'https://linear.app/digimondo/issue/NG-601',
  labels: ['rocky'],
};

function header(over: Partial<RunHeader> = {}): RunHeader {
  return {
    ...newRunHeader({
      runId: 'NG-601-1',
      issue,
      branch: 'ng-601-journal-and-replay',
      trigger: 'linear.onDelegate',
      now: '2026-09-02T10:00:00.000Z',
    }),
    ...over,
  };
}

/** Journals a Boot's worth of lines for `NG-601-1`. */
async function journal(
  ...entries: {
    seq: number;
    step: string;
    status: 'running' | 'done';
    boot?: number;
  }[]
): Promise<void> {
  for (const entry of entries) {
    await appendEntry(
      paths.run('NG-601-1').journal,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: entry.seq,
        step: entry.step,
        status: entry.status,
        boot: entry.boot ?? 1,
        startedAt: '2026-09-02T10:00:01.000Z',
      },
      { runner: entry.step.startsWith('$') },
    );
  }
}

describe('a new header', () => {
  it('starts queued, at zero boots, carrying the snapshot', () => {
    const created = header();

    expect(created).toMatchObject({
      v: RUN_HEADER_VERSION,
      runId: 'NG-601-1',
      status: 'queued',
      boots: 0,
      issue,
      branch: 'ng-601-journal-and-replay',
      trigger: 'linear.onDelegate',
      createdAt: '2026-09-02T10:00:00.000Z',
    });
    expect(created.outcome).toBeUndefined();
    expect(created.endedAt).toBeUndefined();
  });

  it('does not invent a Trigger when a Run was started without one', () => {
    const created = newRunHeader({
      runId: 'NG-601-1',
      issue,
      branch: 'ng-601-journal-and-replay',
      now: '2026-09-02T10:00:00.000Z',
    });

    expect(created.trigger).toBeUndefined();
  });
});

describe('writing the header', () => {
  it('round-trips through run.json', async () => {
    await writeRunHeader(paths, header());

    const text = await readFile(paths.run('NG-601-1').runJson, 'utf8');

    expect(JSON.parse(text)).toEqual(header());
  });

  it('leaves no temp file behind, and the file world-readable', async () => {
    await writeRunHeader(paths, header());

    const dir = paths.run('NG-601-1').dir;
    expect(readdirSync(dir)).toEqual(['run.json']);

    if (POSIX) {
      expect(statSync(join(dir, 'run.json')).mode & 0o777).toBe(0o644);
    }
  });

  it('replaces an existing header rather than appending to it', async () => {
    await writeRunHeader(paths, header());
    await writeRunHeader(paths, header({ status: 'running', boots: 1 }));

    const text = await readFile(paths.run('NG-601-1').runJson, 'utf8');

    expect(JSON.parse(text)).toMatchObject({ status: 'running', boots: 1 });
  });
});

describe('reading a broken header', () => {
  it('names a missing run.json', async () => {
    await expect(readRunHeader(paths, 'NG-601-1')).rejects.toThrow(
      new RunHeaderError('NG-601-1', 'has no run.json'),
    );
  });

  it('rejects invalid JSON rather than indexing a partial header', async () => {
    mkdirSync(paths.run('NG-601-1').dir, { recursive: true });
    await writeFile(paths.run('NG-601-1').runJson, '{ not json');

    await expect(readRunHeader(paths, 'NG-601-1')).rejects.toThrow(
      /run\.json is not valid JSON/,
    );
  });

  it('rejects a valid JSON document that is not a Run header', async () => {
    mkdirSync(paths.run('NG-601-1').dir, { recursive: true });
    await writeFile(paths.run('NG-601-1').runJson, '{}');

    await expect(readRunHeader(paths, 'NG-601-1')).rejects.toThrow(
      /run\.json is not a Run header/,
    );
  });

  it('refuses a header from an incompatible daemon version', async () => {
    await writeRunHeader(paths, header({ v: RUN_HEADER_VERSION + 1 }));

    await expect(readRunHeader(paths, 'NG-601-1')).rejects.toThrow(
      new RegExp(
        `header version ${RUN_HEADER_VERSION + 1}.*version ${RUN_HEADER_VERSION}`,
      ),
    );
  });
});

describe('terminal header outcomes', () => {
  it('converts every complete terminal header to its journal payload', () => {
    expect(
      runEndFor(header({ status: 'finished', outcome: 'merged' })),
    ).toEqual({
      status: 'finished',
      outcome: 'merged',
    });
    expect(
      runEndFor(
        header({
          status: 'failed',
          error: { name: 'Error', message: 'disk full' },
        }),
      ),
    ).toEqual({
      status: 'failed',
      error: { name: 'Error', message: 'disk full' },
    });
    expect(runEndFor(header({ status: 'cancelled' }))).toEqual({
      status: 'cancelled',
    });
  });

  it('does not manufacture incomplete or non-terminal outcomes', () => {
    expect(runEndFor(header({ status: 'finished' }))).toBeUndefined();
    expect(runEndFor(header({ status: 'failed' }))).toBeUndefined();
    expect(runEndFor(header())).toBeUndefined();
    expect(runEndFor(header({ status: 'running' }))).toBeUndefined();
    expect(runEndFor(header({ status: 'parked' }))).toBeUndefined();
  });
});

describe('loading a header the journal disagrees with', () => {
  it('rebuilds a stale boot count from the journal', async () => {
    await writeRunHeader(paths, header({ status: 'running', boots: 1 }));
    await journal(
      { seq: 0, step: 'agent', status: 'done', boot: 1 },
      { seq: 1, step: 'exec', status: 'done', boot: 3 },
    );

    const loaded = await loadRunHeader(paths, 'NG-601-1');

    expect(loaded.boots).toBe(3);
    // The cache is corrected on disk, not just in memory.
    const onDisk = JSON.parse(
      await readFile(paths.run('NG-601-1').runJson, 'utf8'),
    ) as RunHeader;
    expect(onDisk.boots).toBe(3);
  });

  it('rebuilds a header that never learned the Run had ended', async () => {
    // The daemon died between the `$end` line and the header write.
    await writeRunHeader(paths, header({ status: 'running', boots: 1 }));
    await appendEntry(
      paths.run('NG-601-1').journal,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: END_STEP,
        status: 'done',
        boot: 1,
        startedAt: '2026-09-02T10:05:00.000Z',
        ms: 4,
        result: { status: 'finished', outcome: 'merged' },
      },
      { runner: true },
    );

    const loaded = await loadRunHeader(paths, 'NG-601-1');

    expect(loaded).toMatchObject({
      status: 'finished',
      outcome: 'merged',
      endedAt: '2026-09-02T10:05:00.000Z',
    });
  });

  it('rebuilds a failed outcome, error and all', async () => {
    await writeRunHeader(paths, header({ status: 'running', boots: 1 }));
    await appendEntry(
      paths.run('NG-601-1').journal,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 3,
        step: END_STEP,
        status: 'failed',
        boot: 2,
        startedAt: '2026-09-02T11:00:00.000Z',
        result: {
          status: 'failed',
          error: { name: 'DivergenceError', message: 'seq 2 expected exec' },
        },
        error: { name: 'DivergenceError', message: 'seq 2 expected exec' },
      },
      { runner: true },
    );

    const loaded = await loadRunHeader(paths, 'NG-601-1');

    expect(loaded.status).toBe('failed');
    expect(loaded.error?.name).toBe('DivergenceError');
  });

  it('rebuilds a cancelled Run from its terminal journal entry', async () => {
    await writeRunHeader(paths, header({ status: 'running', boots: 1 }));
    await appendEntry(
      paths.run('NG-601-1').journal,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: END_STEP,
        status: 'done',
        boot: 1,
        startedAt: '2026-09-02T11:30:00.000Z',
        result: { status: 'cancelled' },
      },
      { runner: true },
    );

    const loaded = await loadRunHeader(paths, 'NG-601-1');

    expect(loaded).toMatchObject({
      status: 'cancelled',
      endedAt: '2026-09-02T11:30:00.000Z',
    });
  });

  it('does not rewrite a terminal header that already matches its journal', async () => {
    const endedAt = '2026-09-02T11:45:00.000Z';
    await writeRunHeader(
      paths,
      header({
        status: 'finished',
        outcome: 'merged',
        boots: 1,
        endedAt,
      }),
    );
    await appendEntry(
      paths.run('NG-601-1').journal,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: END_STEP,
        status: 'done',
        boot: 1,
        startedAt: endedAt,
        result: { status: 'finished', outcome: 'merged' },
      },
      { runner: true },
    );

    const before = statSync(paths.run('NG-601-1').runJson).mtimeMs;
    await loadRunHeader(paths, 'NG-601-1');

    expect(statSync(paths.run('NG-601-1').runJson).mtimeMs).toBe(before);
  });

  it('leaves an agreeing header untouched', async () => {
    await writeRunHeader(paths, header({ status: 'running', boots: 2 }));
    await journal({ seq: 0, step: 'agent', status: 'done', boot: 2 });

    const before = statSync(paths.run('NG-601-1').runJson).mtimeMs;
    const loaded = await loadRunHeader(paths, 'NG-601-1');

    expect(loaded.status).toBe('running');
    expect(statSync(paths.run('NG-601-1').runJson).mtimeMs).toBe(before);
  });
});

describe('the in-memory index', () => {
  it('is rebuilt from the headers at boot', async () => {
    await writeRunHeader(paths, header());
    await writeRunHeader(
      paths,
      header({ runId: 'NG-602-1', status: 'finished', outcome: 'merged' }),
    );

    const index = await readRunIndex(paths, { warn });

    expect(index.map((run) => run.runId).sort()).toEqual([
      'NG-601-1',
      'NG-602-1',
    ]);
    expect(warnings).toEqual([]);
  });

  it('is empty before any Run has been started', async () => {
    expect(await readRunIndex(paths, { warn })).toEqual([]);
  });

  it('skips a Run directory whose header is gone, and says so', async () => {
    // The issue snapshot and branch live only in the header, so there is
    // nothing to rebuild one from — this Run is unusable, not merely stale.
    mkdirSync(paths.run('NG-603-1').dir, { recursive: true });
    await writeRunHeader(paths, header());

    const index = await readRunIndex(paths, { warn });

    expect(index.map((run) => run.runId)).toEqual(['NG-601-1']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/NG-603-1.*run\.json/s);
  });

  it('skips an unparseable header rather than failing every other Run', async () => {
    await writeRunHeader(paths, header());
    mkdirSync(paths.run('NG-604-1').dir, { recursive: true });
    await writeFile(paths.run('NG-604-1').runJson, '{ not json');

    const index = await readRunIndex(paths, { warn });

    expect(index.map((run) => run.runId)).toEqual(['NG-601-1']);
    expect(warnings[0]).toMatch(/NG-604-1/);
  });

  it('reconciles each header against its own journal as it loads', async () => {
    await writeRunHeader(paths, header({ status: 'running', boots: 1 }));
    await journal({ seq: 0, step: 'agent', status: 'done', boot: 4 });

    const index = await readRunIndex(paths, { warn });

    expect(index[0]?.boots).toBe(4);
  });
});
