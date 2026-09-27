import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('.qualification/independent-foundation');
mkdirSync(root, { recursive: true });
const attempt = mkdtempSync(join(root, 'attempt-'));
const packageRoot = process.env.ROCKY_PACKAGE_ROOT;
assert.ok(packageRoot, 'ROCKY_PACKAGE_ROOT must name a clean installed package');
const moduleUrl = pathToFileURL(resolve(packageRoot, 'dist/index.js')).href;
const { Store, Evidence, CommandRunner, configure, withFreshReadiness } = await import(moduleUrl);
const versions = { workflow: 'wf-1', adapter: 'aa-1', prompt: 'p-1', runner: 'r-1', build: 'build-A' };
const inputs = { head: 'H', base: 'B', scope: 'S', scenario: 'browser', fixture: 'fresh-db', command: 'check-v1', toolchain: 'node-24' };
const childFile = resolve('acceptance/foundation-independent-worker.mjs');
function dir(name) { const value = join(attempt, name); mkdirSync(value); return value; }
function fresh(name, config = {}) {
  const location = dir(name);
  const db = join(location, 'state.sqlite');
  const store = new Store(db);
  store.admit({ id: 'run', head: 'H', base: 'B', scope: 'S', versions, config });
  return { location, db, store };
}
function receipt(name, value) { writeFileSync(join(attempt, `${name}.json`), JSON.stringify(value, null, 2)); }
function waitFor(check, ms = 3000) { return new Promise((resolve, reject) => {
  const until = Date.now() + ms;
  const poll = () => { const value = check(); if (value) resolve(value); else if (Date.now() > until) reject(new Error('timed-out-waiting-for-observation')); else setTimeout(poll, 25); };
  poll();
}); }
function alive(pid) { try { const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); return Boolean(state) && !state.startsWith('Z'); } catch { return false; } }
function worker(mode, db, data) { return fork(childFile, [mode, moduleUrl, db, data], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); }
async function stop(child) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); }

test('F01 F03 F09 committed run, atomic rejected transition, compatible resume', () => {
  const { db, store } = fresh('transaction');
  const lease = store.claim('run', 'first', versions, 1000);
  store.transition(lease, 'checked', { key: 'run/check/1', kind: 'check', payload: { head: 'H' } });
  const before = { run: store.get('run'), events: store.events('run'), effect: store.effect('run/check/1') };
  assert.throws(() => store.transition(lease, 'corrupt', { key: 'run/check/1', kind: 'check', payload: { head: 'OTHER' } }), /operation-key-conflict/);
  assert.deepEqual({ run: store.get('run'), events: store.events('run'), effect: store.effect('run/check/1') }, before);
  store.release(lease); store.close();
  const reopened = new Store(db);
  assert.deepEqual(reopened.get('run'), before.run);
  assert.equal(reopened.effect('run/check/1').state, 'pending');
  assert.throws(() => reopened.claim('run', 'changed', { ...versions, workflow: 'wf-2' }, 1000), /incompatible-versions/);
  const next = reopened.claim('run', 'compatible', versions, 1000);
  assert.equal(reopened.get('run').stage, 'checked');
  receipt('transaction', { before, after: reopened.get('run'), next, events: reopened.events('run') });
  reopened.close();
});

test('F02 real competing claimers and expired owner cannot start or mutate', async () => {
  const { db, store } = fresh('fencing');
  const children = [worker('claim', db, ''), worker('claim', db, '')];
  try {
    const messages = children.map(child => once(child, 'message').then(([message]) => message));
    children.forEach(child => child.send('go'));
    const results = await Promise.all(messages);
    assert.equal(results.filter(result => result.lease).length, 1);
    const old = results.find(result => result.lease).lease;
    await new Promise(resolve => setTimeout(resolve, 300));
    const newLease = store.claim('run', 'replacement', versions, 1000);
    assert.ok(newLease.fence > old.fence);
    const snapshot = { run: store.get('run'), events: store.events('run') };
    assert.throws(() => store.transition(old, 'stale', { key: 'stale', kind: 'fake', payload: {} }), /stale-lease/);
    assert.throws(() => store.guardedStart(old, () => { throw new Error('BAD_SEND'); }), /stale-lease/);
    assert.deepEqual({ run: store.get('run'), events: store.events('run') }, snapshot);
    receipt('fencing', { results, old, newLease, snapshot });
  } finally { await Promise.all(children.map(stop)); store.close(); }
});

test('F04 F05 killed response owner, ambiguous reconciliation and cancellation', async () => {
  const { location, db, store } = fresh('effects');
  const ledger = join(location, 'external-ledger.json'); writeFileSync(ledger, JSON.stringify({ creates: 0 }));
  const child = worker('lost-effect', db, ledger);
  try {
    const [message] = await once(child, 'message'); assert.equal(message.ledgerWritten, true);
    await stop(child);
    await new Promise(resolve => setTimeout(resolve, 300));
    const lease = store.claim('run', 'reconciler', versions, 2000);
    const sent = store.effect('run/draft/1'); assert.equal(sent.state, 'sending');
    let attempts = 0;
    await assert.rejects(() => store.dispatch(lease, sent.key, { begin: () => { attempts++; return Promise.resolve({}); } }), /reconciliation-required/);
    const unknown = await store.reconcile(lease, sent.key, async () => ({ status: 'unknown' }));
    assert.equal(unknown.state, 'unresolved'); assert.equal(unknown.receipt, null);
    store.cancel('run');
    const confirmed = await store.reconcile(lease, sent.key, async () => ({ status: 'confirmed', receipt: JSON.parse(readFileSync(ledger)) }));
    assert.equal(confirmed.state, 'confirmed'); assert.equal(confirmed.receipt.creates, 1);
    assert.equal(attempts, 0); assert.equal(JSON.parse(readFileSync(ledger)).creates, 1);
    assert.throws(() => store.transition(lease, 'later', { key: 'new-send', kind: 'fake', payload: {} }), /cancelled/);
    receipt('effects', { sent, unknown, confirmed, attempts, ledger: JSON.parse(readFileSync(ledger)), canceled: store.get('run').cancelled });
  } finally { await stop(child); store.close(); }
});

test('F06 F11 each identity change, tamper/missing and fresh readiness', async () => {
  const location = dir('evidence'); const evidence = new Evidence(location);
  const artifact = evidence.put('browser trace');
  const reference = evidence.record({ schema: 1, kind: 'browser', inputs, outcome: 'pass', artifacts: [artifact] });
  assert.equal(evidence.validate(reference, inputs).valid, true);
  const changes = {};
  for (const key of Object.keys(inputs)) { const result = evidence.validate(reference, { ...inputs, [key]: `${inputs[key]}-changed` }); assert.equal(result.reason, 'stale-inputs'); changes[key] = result.reason; }
  let polls = 0, executions = 0;
  await withFreshReadiness(async () => { polls++; return true; }, async () => { executions++; });
  await assert.rejects(() => withFreshReadiness(async () => { polls++; return false; }, async () => { executions++; }), /service-not-ready/);
  assert.equal(evidence.validate(reference, inputs).valid, true); assert.equal(polls, 2); assert.equal(executions, 1);
  writeFileSync(join(location, artifact.sha256), 'corrupted');
  assert.equal(evidence.validate(reference, inputs).reason, 'evidence-integrity-failure');
  unlinkSync(join(location, artifact.sha256));
  assert.equal(evidence.validate(reference, inputs).reason, 'missing-evidence');
  receipt('evidence', { artifact, reference, changes, polls, executions, tamper: 'evidence-integrity-failure', missing: 'missing-evidence' });
});

test('F07 F10 command timeout, output cap, sentinel, validated config', async () => {
  const { location, store } = fresh('command');
  const lease = store.claim('run', 'runner', versions, 1000);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const result = await new CommandRunner(store).run(lease, {
      file: process.execPath,
      args: ['-e', "process.stdout.write('OUT:'+ 'x'.repeat(4096));process.stderr.write('ERR:'+ 'y'.repeat(4096));setInterval(()=>{},1000)"],
      cwd: location, outputDir: join(location, 'output'), timeoutMs: 250, cleanupMs: 150, logBytes: 64,
    });
    assert.equal(result.result.outcome, 'timeout');
    assert.equal(result.result.stdoutTruncated, true); assert.equal(result.result.stderrTruncated, true);
    assert.ok(readFileSync(result.result.stdout, 'utf8').startsWith('OUT:'));
    assert.ok(readFileSync(result.result.stderr, 'utf8').startsWith('ERR:'));
    assert.ok(readFileSync(result.result.stdout).length <= 64);
    assert.ok(alive(sentinel.pid));
    assert.throws(() => configure({ capacity: 2 }), /unsupported-configuration/);
    assert.throws(() => configure({ credentialRefs: { api: 'raw-secret' } }), /credential-reference-required/);
    const config = configure({ credentialRefs: { api: 'env:SYNTHETIC_TOKEN' } });
    assert.equal(config.provenance.credentialRefs, 'operator');
    assert.equal(JSON.stringify(config).includes('SYNTHETIC-SECRET-DO-NOT-LOG'), false);
    receipt('command', { result, sentinelPid: sentinel.pid, sentinelAlive: alive(sentinel.pid), config });
  } finally { await stop(sentinel); store.close(); }
});

test('F05 F07 cancellation terminates owned descendant and retains partial logs', async () => {
  const { location, store } = fresh('cancel-process', { leaseMs: 300 });
  const lease = store.claim('run', 'runner', versions, 1000);
  const descendantFile = join(location, 'descendant.pid');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const script = "const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));console.log('BEFORE_CANCEL');setInterval(()=>{},1000)";
    const runner = new CommandRunner(store);
    const id = runner.start(lease, { file: process.execPath, args: ['-e', script, descendantFile], cwd: location, outputDir: join(location, 'output'), timeoutMs: 10000, cleanupMs: 200, logBytes: 128 });
    const waiting = runner.wait(lease, id);
    await waitFor(() => existsSync(descendantFile));
    const descendant = Number(readFileSync(descendantFile));
    store.cancel('run');
    const final = await waiting;
    assert.equal(final.result.outcome, 'cancelled');
    assert.ok(readFileSync(final.result.stdout, 'utf8').includes('BEFORE_CANCEL'));
    await waitFor(() => !alive(descendant));
    assert.ok(alive(sentinel.pid));
    assert.throws(() => runner.start(lease, { file: process.execPath, args: [], cwd: location, outputDir: location, timeoutMs: 100, cleanupMs: 100, logBytes: 10 }), /cancelled/);
    receipt('cancel-process', { final, descendant, descendantAlive: alive(descendant), sentinelPid: sentinel.pid, sentinelAlive: alive(sentinel.pid), canceled: store.get('run').cancelled });
  } finally { await stop(sentinel); store.close(); }
});

test('F08 killed worker reclaims command without second start and preserves workspace', async () => {
  const { location, db, store } = fresh('worker-death', { leaseMs: 300 });
  const marker = join(location, 'unpublished.txt'); writeFileSync(marker, 'unpublished bytes');
  const started = join(location, 'started.txt');
  const child = worker('command', db, started);
  try {
    const [{ id }] = await once(child, 'message');
    await waitFor(() => existsSync(started));
    await stop(child);
    await new Promise(resolve => setTimeout(resolve, 350));
    const lease = store.claim('run', 'recoverer', versions, 2000);
    const runner = new CommandRunner(store);
    const recovered = runner.recover(lease, id);
    assert.ok(['running', 'finished'].includes(recovered.state));
    if (recovered.state !== 'finished') assert.throws(() => runner.start(lease, { file: process.execPath, args: ['-e', '0'], cwd: location, outputDir: location, timeoutMs: 1000, cleanupMs: 100, logBytes: 64 }), /command-recovery-required/);
    const final = await waitFor(() => { const record = store.command(id); return record.state === 'finished' && record; });
    assert.equal(final.result.outcome, 'lease-lost');
    assert.equal(readFileSync(marker, 'utf8'), 'unpublished bytes');
    const uncertainId = 'uncertain-process';
    store.reserveCommand(lease, uncertainId, 'capability', {});
    store.observeCommand(uncertainId, 'capability', { supervisor: { pid: process.pid, fingerprint: 'wrong' }, group: { pid: process.pid, fingerprint: 'wrong' } });
    const uncertain = runner.recover(lease, uncertainId);
    assert.equal(uncertain.state, 'recovery-required'); assert.ok(alive(process.pid));
    receipt('worker-death', { recovered, final, uncertain, markerSha256: createHash('sha256').update(readFileSync(marker)).digest('hex') });
  } finally { await stop(child); store.close(); }
});

test('F10 installed command identity and credential absence', () => {
  const installed = JSON.parse(execFileSync(join(packageRoot, 'dist/cli.js'), ['identity'], { encoding: 'utf8' }));
  assert.equal(installed.sourceCommit, process.env.ROCKY_SOURCE_COMMIT);
  assert.equal(installed.sourceDirty, false);
  for (const [file, expected] of Object.entries(installed.files)) assert.equal(createHash('sha256').update(readFileSync(join(packageRoot, file))).digest('hex'), expected);
  const config = execFileSync(join(packageRoot, 'dist/cli.js'), ['config'], { encoding: 'utf8', env: { PATH: process.env.PATH, SYNTHETIC_TOKEN: 'SYNTHETIC-SECRET-DO-NOT-LOG' } });
  assert.equal(config.includes('SYNTHETIC-SECRET-DO-NOT-LOG'), false);
  receipt('package', { installed, secretAbsent: true, packageRoot });
});

process.on('exit', () => { writeFileSync(join(attempt, 'attempt.json'), JSON.stringify({ sourceCommit: process.env.ROCKY_SOURCE_COMMIT, packageRoot, attempt, finishedAt: new Date().toISOString() }, null, 2)); });
