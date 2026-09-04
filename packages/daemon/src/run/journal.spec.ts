/**
 * AC2 (first half): a torn final line is truncated at boot, and the
 * interrupted-vs-never-reached distinction is asserted.
 * AC3 (second half): a format-version mismatch fails the Run readably.
 *
 * These are the file-format tests. The replay semantics built on top of them
 * live in `replay.spec.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  END_STEP,
  JOURNAL_FORMAT_VERSION,
  JournalFormatError,
  appendEntry,
  openJournal,
  recordError,
  type JournalEntry,
} from './journal.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-journal-'));
  path = join(dir, 'journal.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A settled `done` line, with only the fields a test cares about spelled out. */
function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    v: JOURNAL_FORMAT_VERSION,
    seq: 1,
    step: 'agent',
    status: 'done',
    boot: 1,
    startedAt: '2026-09-02T10:00:00.000Z',
    ms: 12,
    ...over,
  };
}

/** Writes pre-baked lines, bypassing `appendEntry`'s validation. */
function writeLines(...lines: string[]): void {
  writeFileSync(path, lines.join(''));
}

function line(over: Partial<JournalEntry> = {}): string {
  return `${JSON.stringify(entry(over))}\n`;
}

describe('an absent journal', () => {
  it('reads as empty and starts at boot 1', async () => {
    const journal = await openJournal(path);

    expect(journal.entries).toEqual([]);
    expect(journal.nextBoot).toBe(1);
    expect(journal.truncated).toBe(false);
    expect(journal.end).toBeUndefined();
  });

  it('surfaces an unreadable journal rather than treating it as absent', async () => {
    mkdirSync(path);

    await expect(openJournal(path)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('appending', () => {
  it('round-trips an entry through the file', async () => {
    const written = entry({ result: { summary: 'planned' }, label: 'plan' });
    await appendEntry(path, written);

    const journal = await openJournal(path);

    expect(journal.entries).toEqual([written]);
    expect(journal.latest(1)).toEqual(written);
  });

  it('writes one newline-terminated line per entry', async () => {
    await appendEntry(path, entry({ seq: 1 }));
    await appendEntry(path, entry({ seq: 2 }));

    const text = readFileSync(path, 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });

  it('refuses a step key in the runner-owned `$` namespace', async () => {
    // `$`-prefixed keys are the runner's so they can never collide with a
    // `ctx.*` key (NG-574 §5) — which only holds if the door is shut.
    await expect(appendEntry(path, entry({ step: '$end' }))).rejects.toThrow(
      /\$end.*runner-owned/s,
    );
  });

  it('accepts the runner-owned keys from the runner itself', async () => {
    await appendEntry(path, entry({ step: END_STEP }), { runner: true });

    const journal = await openJournal(path);

    expect(journal.end?.step).toBe(END_STEP);
  });

  it('refuses an entry at a version this daemon does not write', async () => {
    await expect(
      appendEntry(path, entry({ v: JOURNAL_FORMAT_VERSION + 1 })),
    ).rejects.toThrow(/refusing to append.*format version/s);
  });

  it('refuses an entry that fails the journal schema', async () => {
    await expect(appendEntry(path, entry({ step: '' }))).rejects.toThrow(
      /refusing to append a malformed entry/,
    );
  });
});

describe('a torn final line', () => {
  it('is dropped when the process died mid-write', async () => {
    writeLines(line({ seq: 1 }), '{"v":1,"seq":2,"step":"ex');

    const journal = await openJournal(path);

    expect(journal.truncated).toBe(true);
    expect(journal.entries.map((e) => e.seq)).toEqual([1]);
  });

  it('is dropped when it parses but is not a valid entry', async () => {
    writeLines(line({ seq: 1 }), '{"v":1,"seq":2}\n');

    const journal = await openJournal(path);

    expect(journal.truncated).toBe(true);
    expect(journal.entries.map((e) => e.seq)).toEqual([1]);
  });

  it('repairs the file, so the next append lands on a clean line', async () => {
    writeLines(line({ seq: 1 }), '{"v":1,"seq":2,"step":"ex');

    await openJournal(path);
    await appendEntry(path, entry({ seq: 2, step: 'exec' }));

    const reread = await openJournal(path);

    expect(reread.truncated).toBe(false);
    expect(reread.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('is a corruption rather than a tear when it is not the last line', async () => {
    // A tear has no terminating newline, so it can only ever *be* the last
    // line. An unusable line with one behind it is therefore bit-rot or a
    // hand-edit — real history we must not silently drop.
    writeLines('{"v":1,"seq":1,"step":"ex\n', line({ seq: 2 }));

    await expect(openJournal(path)).rejects.toThrow(JournalFormatError);
    await expect(openJournal(path)).rejects.toThrow(/line 1/);
  });

  it('leaves a journal whose only line is torn empty but usable', async () => {
    writeLines('{"v":1,"seq":1,"ste');

    const journal = await openJournal(path);

    expect(journal.entries).toEqual([]);
    expect(journal.truncated).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('');
  });
});

describe('a format-version mismatch', () => {
  it('fails the Run rather than replaying it wrong', async () => {
    writeLines(line({ seq: 1, v: JOURNAL_FORMAT_VERSION + 1 }));

    await expect(openJournal(path)).rejects.toThrow(JournalFormatError);
  });

  it('names both versions and blames the daemon, not the journal', async () => {
    writeLines(line({ seq: 1, v: 99 }));

    await expect(openJournal(path)).rejects.toThrow(
      new RegExp(
        `format version 99.*this daemon.*${JOURNAL_FORMAT_VERSION}`,
        's',
      ),
    );
  });

  it('is caught even on the last line, which is never treated as torn', async () => {
    // A versioned line is well-formed — it came from an incompatible daemon,
    // not from a half-finished write, so dropping it would lose real history.
    writeLines(line({ seq: 1 }), line({ seq: 2, v: 99 }));

    await expect(openJournal(path)).rejects.toThrow(JournalFormatError);
  });
});

describe('recording thrown values', () => {
  it('preserves an Error name, message and stack for replay', () => {
    const error = new TypeError('bad result');

    expect(recordError(error)).toMatchObject({
      name: 'TypeError',
      message: 'bad result',
      stack: error.stack,
    });
  });

  it('turns a non-Error throw into a replayable Error record', () => {
    expect(recordError('rate limited')).toEqual({
      name: 'Error',
      message: 'rate limited',
    });
  });

  it('omits an absent Error stack from the serialized record', () => {
    const error = new Error('no stack');
    error.stack = undefined;

    expect(recordError(error)).toEqual({ name: 'Error', message: 'no stack' });
  });
});

describe('two-phase writes', () => {
  it('lets the last line for a seq win', async () => {
    await appendEntry(
      path,
      entry({ seq: 1, status: 'running', ms: undefined }),
    );
    await appendEntry(path, entry({ seq: 1, status: 'done', result: 'ok' }));

    const journal = await openJournal(path);

    expect(journal.entries).toHaveLength(2);
    expect(journal.latest(1)?.status).toBe('done');
    expect(journal.latest(1)?.result).toBe('ok');
  });

  it('distinguishes interrupted from never-reached', async () => {
    await appendEntry(path, entry({ seq: 1, status: 'done' }));
    await appendEntry(
      path,
      entry({ seq: 2, status: 'running', ms: undefined }),
    );

    const journal = await openJournal(path);

    expect(journal.isInterrupted(1)).toBe(false);
    expect(journal.isInterrupted(2)).toBe(true);

    // Never reached: no line at all, which is not the same as interrupted.
    expect(journal.isInterrupted(3)).toBe(false);
    expect(journal.latest(3)).toBeUndefined();
  });
});

describe('the boot counter', () => {
  it('is the highest boot seen plus one', async () => {
    await appendEntry(path, entry({ seq: 1, boot: 1 }));
    await appendEntry(path, entry({ seq: 2, boot: 3 }));

    expect((await openJournal(path)).nextBoot).toBe(4);
  });
});

describe('the crash-loop counter', () => {
  it('counts the boots that left one seq unsettled', async () => {
    for (const boot of [1, 2, 3]) {
      await appendEntry(
        path,
        entry({ seq: 1, status: 'running', boot, ms: undefined }),
      );
    }

    expect((await openJournal(path)).interruptedBoots(1)).toBe(3);
  });

  it('resets on a settle, so a parked Step polling for days never trips', async () => {
    // A `waiting` Step writes a fresh `running` line on every poll Boot. Those
    // are settled retries, not a crash loop — counting raw `running` lines
    // would fail a Checkpoint that waited a weekend.
    for (const boot of [1, 2, 3, 4, 5]) {
      await appendEntry(
        path,
        entry({ seq: 1, status: 'running', boot, ms: undefined }),
      );
      await appendEntry(path, entry({ seq: 1, status: 'waiting', boot }));
    }

    expect((await openJournal(path)).interruptedBoots(1)).toBe(0);
  });

  it('counts only the unsettled tail after the last settle', async () => {
    await appendEntry(
      path,
      entry({ seq: 1, status: 'running', boot: 1, ms: undefined }),
    );
    await appendEntry(path, entry({ seq: 1, status: 'waiting', boot: 1 }));
    for (const boot of [2, 3]) {
      await appendEntry(
        path,
        entry({ seq: 1, status: 'running', boot, ms: undefined }),
      );
    }

    expect((await openJournal(path)).interruptedBoots(1)).toBe(2);
  });

  it('ignores a seq that settled', async () => {
    await appendEntry(
      path,
      entry({ seq: 1, status: 'running', boot: 1, ms: undefined }),
    );
    await appendEntry(path, entry({ seq: 1, status: 'done', boot: 1 }));

    expect((await openJournal(path)).interruptedBoots(1)).toBe(0);
  });
});
