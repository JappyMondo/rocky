import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { JournalWriter } from './writer.js';
import { readJournal, type JournalEntry } from './journal.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-writer-'));
  path = join(dir, 'journal.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    v: 1,
    seq: 0,
    step: 'agent',
    status: 'running',
    boot: 1,
    startedAt: '2026-09-07T10:00:00.000Z',
    ...overrides,
  };
}

it('persists control values across reopen without consuming a Step or Boot', async () => {
  const writer = await JournalWriter.open(path);
  await writer.put('linear:control', { pending: ['human words'] });
  await writer.put('linear:control', { pending: ['new words'] });
  const reopened = await JournalWriter.open(path);
  expect(await reopened.get('linear:control')).toEqual({
    pending: ['new words'],
  });
  expect(await reopened.get('missing')).toBeUndefined();
  const journal = await reopened.read();
  expect(journal.entries).toEqual([]);
  expect(journal.nextBoot).toBe(1);
  expect(journal.latest(0)).toBeUndefined();
  expect(journal.interruptedBoots(0)).toBe(0);
  expect(journal.getControl('linear:control')).toEqual({
    pending: ['new words'],
  });
});

it('serializes raced controls and nested Step snapshots by invocation order', async () => {
  const writer = await JournalWriter.open(path);
  const value = { notes: ['original'] };
  const child = entry({ result: { message: 'original' } });
  const nested = entry({
    step: '$parallel',
    parallel: {
      count: 1,
      branches: [[child]],
    },
  });
  const first = writer.put('control', value);
  const append = writer.append(nested, { runner: true });
  const read = writer.get('control');
  const second = writer.put('control', { notes: ['second'] });
  value.notes.push('mutation');
  child.result = 'mutation';
  await Promise.all([first, append, second]);
  expect(await read).toEqual({ notes: ['original'] });
  const journal = await writer.read();
  expect(journal.entries).toHaveLength(1);
  expect(journal.latest(0)?.parallel?.branches[0]?.[0]?.result).toEqual({
    message: 'original',
  });
  expect(journal.nextBoot).toBe(2);
  expect(journal.isInterrupted(0)).toBe(true);
  expect(await writer.get('control')).toEqual({ notes: ['second'] });
  const returned = journal.getControl('control');
  if (typeof returned === 'object' && returned !== null)
    Object.assign(returned, { notes: [] });
  expect(journal.getControl('control')).toEqual({ notes: ['second'] });
});

it('orders terminal after earlier writes and refuses every later write', async () => {
  const writer = await JournalWriter.open(path);
  const before = writer.put('control', 'before');
  const step = writer.append(entry());
  const end = writer.append(
    entry({
      seq: 1,
      step: '$end',
      status: 'done',
      result: { status: 'cancelled' },
    }),
    { runner: true },
  );
  const after = writer.put('control', 'after');
  const lateStep = writer.append(entry({ seq: 2 }));
  await Promise.all([before, step, end]);
  await expect(after).rejects.toThrow(/after \$end/);
  await expect(lateStep).rejects.toThrow(/after \$end/);
  const reopened = await JournalWriter.open(path);
  expect(await reopened.get('control')).toBe('before');
  expect((await reopened.read()).end?.seq).toBe(1);
  await expect(reopened.append(entry({ seq: 2 }))).rejects.toThrow(
    /after \$end/,
  );
});

it('refuses a terminal sequence overlapping an existing Step before writing it', async () => {
  const writer = await JournalWriter.open(path);
  await writer.append(entry({ seq: 2 }));
  await expect(
    writer.append(
      entry({
        seq: 2,
        step: '$end',
        status: 'done',
        result: { status: 'cancelled' },
      }),
      { runner: true },
    ),
  ).rejects.toThrow(/sequence/);
  expect((await readJournal(path)).end).toBeUndefined();
});

it.each(
  [
    undefined,
    { nested: undefined },
    Number.NaN,
    new Date(),
    new Map(),
    { toJSON: () => 'lossy' },
    ['ok', undefined],
  ].map((value) => ({ value })),
)(
  'rejects non-JSON control data and latches before later writes ($value)',
  async ({ value }) => {
    const writer = await JournalWriter.open(path);
    const bad = writer.put('control', value);
    const later = writer.put('control', 'must not persist');
    await expect(bad).rejects.toThrow();
    await expect(later).rejects.toThrow();
    expect((await readJournal(path)).getControl('control')).toBeUndefined();
  },
);

it('latches invalid keys and Step validation failures', async () => {
  const writer = await JournalWriter.open(path);
  await expect(writer.put('', 'invalid')).rejects.toThrow();
  await expect(writer.append(entry())).rejects.toThrow();
  const reopened = await JournalWriter.open(path);
  await expect(reopened.append(entry({ step: '' }))).rejects.toThrow();
  await expect(reopened.put('control', 'later')).rejects.toThrow();
  expect((await readJournal(path)).entries).toEqual([]);
});

it('latches storage failures even if the filesystem becomes writable again', async () => {
  const writer = await JournalWriter.open(path);
  await writer.put('control', 'durable');
  const original = readFileSync(path);
  rmSync(path);
  mkdirSync(path);
  await expect(writer.put('control', 'failed')).rejects.toThrow();
  rmSync(path, { recursive: true });
  writeFileSync(path, original);
  await expect(writer.put('control', 'later')).rejects.toThrow();
  await expect(writer.append(entry())).rejects.toThrow();
  await expect(writer.get('control')).rejects.toThrow();
  expect((await readJournal(path)).getControl('control')).toBe('durable');
});

it('preserves failed and Steer attempts alongside arbitrary control keys', async () => {
  const writer = await JournalWriter.open(path);
  const attempts = [
    {
      kind: 'failed' as const,
      startedAt: '2026-09-07T10:00:00.000Z',
      ms: 3,
      error: { name: 'Error', message: 'retry' },
    },
    {
      kind: 'steer' as const,
      startedAt: '2026-09-07T10:00:01.000Z',
      ms: 5,
      note: 'verbatim\n human words',
      sessionId: 'session',
    },
  ];
  await writer.put('__proto__', { safe: true });
  await writer.append(entry({ attempts }));
  const journal = await writer.read();
  expect(journal.latest(0)?.attempts).toEqual(attempts);
  expect(journal.getControl('__proto__')).toEqual({ safe: true });
  expect(journal.getControl('constructor')).toBeUndefined();
});

it.each([
  { seq: 0 },
  { boot: 1 },
  { key: '' },
  { v: 99 },
  { recordedAt: 'not a date' },
  { kind: 'unknown' },
  { value: undefined },
])(
  'refuses complete corrupt control records without repairing them (%j)',
  async (invalid) => {
    const text = `${JSON.stringify({
      v: 1,
      kind: 'control',
      key: 'control',
      value: null,
      recordedAt: '2026-09-07T10:00:00.000Z',
      ...invalid,
    })}\n`;
    writeFileSync(path, text);
    await expect(JournalWriter.open(path)).rejects.toThrow();
    await expect(readJournal(path)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(text);
  },
);

it('refuses a complete control record after a persisted terminal', async () => {
  writeFileSync(
    path,
    `${JSON.stringify(
      entry({ step: '$end', status: 'done', result: { status: 'cancelled' } }),
    )}\n${JSON.stringify({
      v: 1,
      kind: 'control',
      key: 'late',
      value: true,
      recordedAt: '2026-09-07T10:00:00.000Z',
    })}\n`,
  );
  await expect(JournalWriter.open(path)).rejects.toThrow(/after \$end/);
  await expect(readJournal(path)).rejects.toThrow(/after \$end/);
});

it('repairs a torn control tail only at exclusive owner startup', async () => {
  const writer = await JournalWriter.open(path);
  await writer.put('control', { notes: ['durable'] });
  const complete = readFileSync(path, 'utf8');
  const torn = `${complete}{"v":1,"kind":"control","value":"partial`;
  writeFileSync(path, torn);
  const live = await writer.read();
  expect(live.truncated).toBe(true);
  expect(live.getControl('control')).toEqual({ notes: ['durable'] });
  expect(readFileSync(path, 'utf8')).toBe(torn);
  const reopened = await JournalWriter.open(path);
  expect(readFileSync(path, 'utf8')).toBe(complete);
  await reopened.put('control', 'recovered');
  expect(await reopened.get('control')).toBe('recovered');
});

it('latches cyclic input capture without letting queued writes proceed', async () => {
  const writer = await JournalWriter.open(path);
  const value: { self?: unknown } = {};
  value.self = value;
  await expect(writer.put('control', value)).rejects.toThrow();
  await expect(writer.put('control', 'later')).rejects.toThrow();
  expect((await readJournal(path)).getControl('control')).toBeUndefined();
});
