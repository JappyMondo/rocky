import { readFileSync, writeFileSync } from 'node:fs';

const [mode, moduleUrl, db, ledger] = process.argv.slice(2);
const { Store, CommandRunner } = await import(moduleUrl);
const versions = { workflow: 'wf-1', adapter: 'aa-1', prompt: 'p-1', runner: 'r-1', build: 'build-A' };
const store = new Store(db);

if (mode === 'claim') {
  process.on('message', message => {
    if (message !== 'go') return;
    try { process.send({ lease: store.claim('run', `claim-${process.pid}`, versions, 250) }); }
    catch (error) { process.send({ error: error.message }); }
    store.close();
  });
} else if (mode === 'lost-effect') {
  const lease = store.claim('run', 'lost-worker', versions, 250);
  store.transition(lease, 'publishing', { key: 'run/draft/1', kind: 'fake-draft', payload: { head: 'H' } });
  await store.dispatch(lease, 'run/draft/1', {
    begin: () => {
      const prior = JSON.parse(readFileSync(ledger));
      writeFileSync(ledger, JSON.stringify({ creates: prior.creates + 1, remoteId: 'fake-pr-1' }));
      process.send({ ledgerWritten: true });
      return new Promise(() => {});
    },
  });
} else if (mode === 'command') {
  const lease = store.claim('run', 'command-worker', versions, 300);
  const runner = new CommandRunner(store);
  const id = runner.start(lease, {
    file: process.execPath,
    args: ['-e', "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'started');console.log('PARTIAL');setInterval(()=>{},1000)", ledger],
    cwd: process.cwd(), outputDir: ledger + '-output', timeoutMs: 10000, cleanupMs: 150, logBytes: 64,
  });
  process.send({ id });
  await runner.wait(lease, id);
}
