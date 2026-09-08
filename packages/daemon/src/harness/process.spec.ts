import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runProcess } from './process.js';

it('lets an owned child flush after its SIGINT group leader exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-flush-'));
  const marker = join(root, 'flushed');
  const abort = new AbortController();
  try {
    await expect(
      runProcess({
        command: process.execPath,
        args: [
          '-e',
          'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",`process.on("SIGINT",()=>setTimeout(()=>{require("node:fs").writeFileSync(process.env.MARKER,"flushed");process.exit(0)},75));setInterval(()=>{},1000)`],{env:process.env,stdio:"ignore"});process.on("SIGINT",()=>process.exit(0));setTimeout(()=>console.log("boundary"),100);setInterval(()=>{},1000);',
        ],
        env: { ...process.env, MARKER: marker },
        signal: abort.signal,
        onLine: () => abort.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(marker, 'utf8')).toBe('flushed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
