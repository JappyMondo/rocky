import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';

// This supervisor never imports Workflow code, so owner loss is actionable even
// while the import worker is stuck in synchronous top-level code.
process.on('disconnect', () => process.kill(-process.pid, 'SIGKILL'));
const entry = new URL('./validate-worker.js', import.meta.url);
if (!existsSync(entry)) entry.pathname = entry.pathname.replace(/\.js$/, '.ts');
const worker = fork(entry, [process.argv[2]], {
  execArgv: [],
  detached: false,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
let responded = false;
worker.once('message', (message) => {
  responded = true;
  process.send?.(message);
});
worker.once('error', (error) => {
  responded = true;
  process.send?.({ error: error.message });
});
worker.once('exit', (code, signal) => {
  if (!responded)
    process.send?.({
      error: `import process exited (${code ?? signal}) without a Trigger table`,
    });
});
