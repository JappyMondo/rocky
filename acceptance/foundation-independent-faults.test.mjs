import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('.qualification/independent-foundation-faults');
mkdirSync(root, { recursive: true });
const attempt = mkdtempSync(join(root, 'attempt-'));
assert.ok(process.env.ROCKY_PACKAGE_ROOT, 'ROCKY_PACKAGE_ROOT must name the clean installed package');
const packageRoot = resolve(process.env.ROCKY_PACKAGE_ROOT);
const moduleUrl = pathToFileURL(join(packageRoot, 'dist/index.js')).href;
const { Store, CommandRunner } = await import(moduleUrl);
const identity = JSON.parse(readFileSync(join(packageRoot, 'dist/build-identity.json')));
assert.equal(identity.sourceCommit, process.env.ROCKY_SOURCE_COMMIT);
assert.equal(identity.sourceDirty, false);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [file, expected] of Object.entries(identity.files)) assert.equal(hash(readFileSync(join(packageRoot, file))), expected);
const versions = { workflow: 'wf-1', adapter: 'aa-1', prompt: 'p-1', runner: 'r-1', build: 'build-A' };
const fixture = resolve('acceptance/foundation-independent-fault-worker.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function receipt(file, value) { writeFileSync(join(attempt, file + '.json'), JSON.stringify(value, null, 2)); }
async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await pause(10); }
  throw new Error('bounded-observation-timeout');
}
function alive(pid) {
  try { const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return Boolean(state) && !state.startsWith('Z'); }
  catch { return false; }
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { exitCode: child.exitCode, signal: child.signalCode };
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  const [exitCode, signal] = await exited;
  return { exitCode, signal };
}
function setup(name) {
  const location = join(attempt, name); mkdirSync(location);
  const db = join(location, 'state.sqlite');
  const store = new Store(db);
  store.admit({ id: 'run', head: 'H', base: 'B', scope: 'S', versions });
  return { location, db, store };
}
function snapshot(store) { return { run: store.get('run'), events: store.events('run'), effect: store.effect('run/crash/1') ?? null }; }

for (const mode of ['payload-getter', 'after-intent-write', 'committed-before-dispatch']) {
  test(`F03 actual SIGKILL through Store.transition: ${mode}`, async () => {
    const { location, db, store } = setup(mode); store.close();
    const marker = join(location, 'barrier.json');
    const out = openSync(join(location, 'worker.stdout'), 'wx'), err = openSync(join(location, 'worker.stderr'), 'wx');
    const child = spawn(process.execPath, [fixture, mode, moduleUrl, db, marker], { stdio: ['ignore', out, err] });
    closeSync(out); closeSync(err);
    let reopened;
    try {
      await waitFor(() => existsSync(marker));
      const fault = JSON.parse(readFileSync(marker));
      const death = await kill(child);
      assert.equal(death.signal, 'SIGKILL'); assert.equal(death.exitCode, null);
      reopened = new Store(db);
      const after = snapshot(reopened);
      receipt(mode, { fault, death, after, workerAlive: alive(child.pid) });
      assert.equal(alive(child.pid), false);
      if (mode !== 'committed-before-dispatch') {
        assert.equal(fault.transitionReturned, false);
        assert.equal(fault.inside.run.stage, 'publishing');
        assert.equal(fault.inside.events.at(-1).kind, 'transition');
        assert.equal(fault.inside.events.length, fault.before.events.length + 1);
        assert.equal(fault.inside.effect?.state ?? null, mode === 'after-intent-write' ? 'pending' : null);
        assert.deepEqual(after, fault.before, 'state, event and intent must roll back together after actual death');
      } else {
        assert.equal(fault.transitionReturned, true);
        assert.deepEqual(after, fault.committed);
        assert.equal(after.run.stage, 'publishing');
        assert.equal(after.effect.state, 'pending'); assert.equal(after.effect.receipt, null);
        assert.equal(after.events.at(-1).kind, 'effect-intent');
        assert.equal(fault.dispatchCalls, 0);
        await pause(550);
        const next = reopened.claim('run', 'replacement', versions, 2000);
        let sends = 0;
        await assert.rejects(() => reopened.dispatch(fault.lease, 'run/crash/1', { begin: () => { sends++; return Promise.resolve({ bad: true }); } }), /stale-lease/);
        assert.equal(sends, 0); assert.equal(reopened.effect('run/crash/1').receipt, null);
        const confirmed = await reopened.dispatch(next, 'run/crash/1', { begin: () => { sends++; return Promise.resolve({ localReceipt: 'replacement-only' }); } });
        assert.equal(sends, 1); assert.equal(confirmed.state, 'confirmed');
        receipt(mode + '-replacement', { next, staleSends: 0, sends, confirmed, events: reopened.events('run') });
      }
    } finally { await kill(child); reopened?.close(); }
  });
}

test('F07 successful below-cap stdout/stderr drain: exact bytes, tails and hashes across 20 bounded repetitions', async () => {
  const { location, store } = setup('output-drain');
  const lease = store.claim('run', 'output-validator', versions, 5000);
  const results = [];
  try {
    for (const cleanupMs of [1, 100]) for (const size of [512 * 1024, 4 * 1024 * 1024]) for (let repetition = 0; repetition < 5; repetition++) {
      const label = `${cleanupMs}ms-${size}bytes-${repetition}`;
      const marker = join(location, label + '-writer.json');
      const start = Date.now();
      const final = await new CommandRunner(store).run(lease, {
        file: process.execPath, args: [fixture, 'output', moduleUrl, String(size), marker],
        cwd: location, outputDir: join(location, label), timeoutMs: 15000, cleanupMs, logBytes: size + 1024,
      });
      const writer = existsSync(marker) ? JSON.parse(readFileSync(marker)) : null;
      const observed = {};
      for (const [name, byte] of [['stdout', 79], ['stderr', 69]]) {
        const expected = Buffer.alloc(size, byte), tail = `\n${name.toUpperCase()}_TAIL_${size}\n`;
        expected.write(tail, size - Buffer.byteLength(tail));
        const path = final.result?.[name];
        const actual = path && existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
        observed[name] = { bytes: actual.length, sha256: hash(actual), expectedSha256: hash(expected), tailPresent: actual.subarray(-Buffer.byteLength(tail)).toString() === tail };
      }
      await waitFor(() => !alive(final.supervisor?.pid) && !alive(final.group?.pid) && (!writer || !alive(writer.pid)));
      const result = { label, elapsedMs: Date.now() - start, final, writer, observed, processesStopped: true };
      results.push(result); receipt('output-drain', results);
      assert.equal(final.state, 'finished', label);
      assert.equal(final.result.outcome, 'success', label); assert.equal(final.result.exitCode, 0, label);
      assert.ok(writer, `${label}: writer must finish every synchronous write`);
      for (const name of ['stdout', 'stderr']) {
        assert.equal(writer.completedWrites[name].bytes, size, `${label} ${name} writer`);
        assert.equal(writer.completedWrites[name].sha256, observed[name].expectedSha256, `${label} ${name} writer hash`);
        assert.equal(final.result[name + 'Truncated'], false, `${label} ${name} truncated`);
        assert.equal(observed[name].bytes, size, `${label} ${name} exact length`);
        assert.equal(observed[name].sha256, observed[name].expectedSha256, `${label} ${name} exact hash`);
        assert.equal(observed[name].tailPresent, true, `${label} ${name} final tail`);
        assert.equal(final.result[name + 'Artifact'].sha256, observed[name].expectedSha256, `${label} ${name} artifact`);
      }
    }
  } finally { store.close(); }
});

receipt('identity', { attempt, packageRoot, identity, testSha256: hash(readFileSync(new URL(import.meta.url))), fixtureSha256: hash(readFileSync(fixture)) });
console.log(`Retained independent crash/drain artifacts: ${attempt}`);
