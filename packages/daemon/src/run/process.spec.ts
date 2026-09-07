import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startCommand, type OwnedCommand } from './process.js';

let dir: string;
const commands: OwnedCommand[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-process-'));
});
afterEach(async () => {
  await Promise.all(commands.splice(0).map((command) => command.stop()));
  await rm(dir, { recursive: true, force: true });
});

it('bounds output rather than accumulating an unbounded command stream', async () => {
  const command = startCommand(
    `"${process.execPath}" -e 'process.stdout.write("x".repeat(17 * 1024 * 1024))'`,
    { cwd: dir, background: false },
  );
  commands.push(command);
  await expect(command.result).rejects.toThrow(/16 MiB/);
  await command.closed;
});

it('does not start a command whose cancellation was already requested', async () => {
  const command = startCommand('sleep 600', {
    cwd: dir,
    background: false,
    signal: AbortSignal.abort(),
  });
  commands.push(command);
  await expect(command.result).rejects.toThrow(/cancelled/);
  await command.closed;
});

it('kills an orphaned shell group after its owning daemon is SIGKILLed', async () => {
  const pidFile = join(dir, 'pid');
  const script = `import { writeFile } from 'node:fs/promises';
    import { startCommand } from ${JSON.stringify(new URL('./process.ts', import.meta.url).href)};
    const child = startCommand('sleep 600', { cwd: ${JSON.stringify(dir)}, background: true });
    const result = await child.result;
    await writeFile(${JSON.stringify(pidFile)}, String(result.pid));`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'ignore',
  });
  const closed = once(owner, 'close');
  try {
    await vi.waitFor(async () =>
      expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0),
    );
    const pid = Number(await readFile(pidFile, 'utf8'));
    owner.kill('SIGKILL');
    await closed;
    await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow());
  } finally {
    owner.kill('SIGKILL');
    await closed;
  }
});
