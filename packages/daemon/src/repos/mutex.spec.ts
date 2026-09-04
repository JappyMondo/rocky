/**
 * The per-repo mutex (NG-578: "a per-repo mutex serializes only the operations
 * touching the shared clone — fetch, worktree add/remove, the sweep").
 *
 * Every test here is about the half of that sentence people forget: *only*.
 * Two Runs on one repo are allowed to work at the same time, so a mutex that
 * held for the length of a Run would be the wrong shape even if it were safe.
 */
import { describe, expect, it } from 'vitest';

import { KeyedMutex } from './mutex.js';

/** A deferred, so a test can hold a critical section open on purpose. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-scheduled microtask run, so `run`'s body has started. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('one key', () => {
  it('never lets two critical sections overlap', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    let inside = 0;

    const section = async (name: string) =>
      mutex.run('niotix', async () => {
        inside += 1;
        expect(inside).toBe(1);
        log.push(`${name} in`);
        await Promise.resolve();
        log.push(`${name} out`);
        inside -= 1;
      });

    await Promise.all([section('a'), section('b'), section('c')]);

    expect(log).toEqual(['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
  });

  it('hands the lock on in the order it was asked for', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();
    const order: string[] = [];

    const held = mutex.run('niotix', async () => {
      order.push('held');
      await gate.promise;
    });

    const queued = ['second', 'third', 'fourth'].map((name) =>
      mutex.run('niotix', async () => {
        order.push(name);
      }),
    );

    await tick();
    expect(order).toEqual(['held']);

    gate.resolve();
    await Promise.all([held, ...queued]);

    expect(order).toEqual(['held', 'second', 'third', 'fourth']);
  });

  it('releases when the critical section throws, rather than wedging the repo', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.run('niotix', () => Promise.reject(new Error('fetch failed'))),
    ).rejects.toThrow('fetch failed');

    // A mutex that leaked on the error path would make one bad fetch cost
    // every later Run on that repo, and the symptom would be a hang.
    await expect(mutex.run('niotix', async () => 'after')).resolves.toBe(
      'after',
    );
    expect(mutex.isHeld('niotix')).toBe(false);
  });

  it('reports the queue, which is what a hang diagnosis needs', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();

    const held = mutex.run('niotix', () => gate.promise);
    const queued = mutex.run('niotix', async () => undefined);

    await tick();
    expect(mutex.isHeld('niotix')).toBe(true);
    expect(mutex.waiting('niotix')).toBe(1);

    gate.resolve();
    await Promise.all([held, queued]);

    expect(mutex.isHeld('niotix')).toBe(false);
    expect(mutex.waiting('niotix')).toBe(0);
  });
});

describe('several keys', () => {
  it('lets different repos proceed at once — a grouped Run takes each member', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();
    const entered: string[] = [];

    const niotix = mutex.run('niotix', async () => {
      entered.push('niotix');
      await gate.promise;
    });
    await tick();
    const api = mutex.run('niota-api', async () => {
      entered.push('niota-api');
    });

    await api;
    // `niota-api` finished while `niotix` was still holding its own lock,
    // which is the whole point of keying by repo rather than one global lock.
    expect(entered).toEqual(['niotix', 'niota-api']);

    gate.resolve();
    await niotix;
  });
});

describe('acquiring by hand', () => {
  it('is available for a caller that spans several git commands', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const release = await mutex.acquire('niotix');
    const queued = mutex.run('niotix', async () => log.push('queued'));

    log.push('fetch');
    log.push('worktree add');
    expect(log).toEqual(['fetch', 'worktree add']);

    release();
    await queued;
    expect(log).toEqual(['fetch', 'worktree add', 'queued']);
  });

  it('ignores a second release, so a doubled `finally` cannot free the next turn too', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();
    const ran: string[] = [];

    const release = await mutex.acquire('niotix');
    const second = mutex.run('niotix', async () => {
      ran.push('second');
      await gate.promise;
    });
    const third = mutex.run('niotix', async () => {
      ran.push('third');
    });

    release();
    release();
    await Promise.resolve();

    // The doubled release must not have let `third` in beside `second`.
    expect(ran).toEqual(['second']);

    gate.resolve();
    await Promise.all([second, third]);
    expect(ran).toEqual(['second', 'third']);
  });
});
