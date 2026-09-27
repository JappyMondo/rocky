import { writeFileSync, writeSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [mode, moduleUrl, db, observation] = process.argv.slice(2);
const versions = { workflow: 'wf-1', adapter: 'aa-1', prompt: 'p-1', runner: 'r-1', build: 'build-A' };
function durable(value) {
  const temporary = observation + '.writing';
  const fd = openSync(temporary, 'wx');
  writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); closeSync(fd);
  renameSync(temporary, observation);
}
function barrier(value) {
  durable(value);
  // SIGKILL must interrupt the synchronous public call, never a mirrored SQL transaction.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  throw new Error('parent-did-not-kill-at-barrier');
}

if (mode === 'output') {
  const size = Number(db);
  const hashes = {};
  for (const [name, fd, byte] of [['stdout', 1, 79], ['stderr', 2, 69]]) {
    const bytes = Buffer.alloc(size, byte);
    const tail = `\n${name.toUpperCase()}_TAIL_${size}\n`;
    bytes.write(tail, size - Buffer.byteLength(tail));
    let offset = 0;
    while (offset < bytes.length) {
      try { offset += writeSync(fd, bytes, offset, bytes.length - offset); }
      catch (error) {
        if (error.code !== 'EAGAIN') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    }
    hashes[name] = { bytes: offset, sha256: createHash('sha256').update(bytes).digest('hex'), tail };
  }
  // All synchronous writes completed. Normal natural exit; never process.exit() while writing.
  durable({ pid: process.pid, completedWrites: hashes });
} else {
  const { Store } = await import(moduleUrl);
  let store;
  let armed = false;
  const snapshot = () => ({ run: store.get('run'), events: store.events('run'), effect: store.effect('run/crash/1') ?? null });
  store = new Store(db, () => {
    // Public clock callback runs while effect-intent event is being appended, after intent INSERT.
    if (mode === 'after-intent-write' && armed && store.effect('run/crash/1')) {
      barrier({ mode, pid: process.pid, lease, before, inside: snapshot(), transitionReturned: false });
    }
    return Date.now();
  });
  const lease = store.claim('run', 'crash-worker', versions, 500);
  const before = snapshot();
  armed = true;
  const payload = mode === 'payload-getter'
    ? { get head() { barrier({ mode, pid: process.pid, lease, before, inside: snapshot(), transitionReturned: false }); } }
    : { head: 'H' };
  store.transition(lease, 'publishing', { key: 'run/crash/1', kind: 'fake-draft', payload });
  barrier({ mode, pid: process.pid, lease, before, committed: snapshot(), transitionReturned: true, dispatchCalls: 0 });
}
