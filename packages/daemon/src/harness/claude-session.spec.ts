import {
  mkdtemp,
  mkdir,
  readFile,
  lstat,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareClaudeSession, routeClaudeSession } from './claude-session.js';

it('routes only the owned native session, preserves the host login, and restores resume aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-native-session-'));
  try {
    const configDir = join(root, 'host');
    const projectDir = join(configDir, 'projects', 'fixture');
    await mkdir(projectDir, { recursive: true });
    const credential = join(configDir, '.credentials.json');
    await writeFile(credential, 'credential sentinel, never imported by Rocky');
    const id = '11111111-1111-4111-8111-111111111111';
    const native = join(projectDir, `${id}.jsonl`);
    await writeFile(native, 'native record\n');
    const input = {
      transcriptPath: join(root, 'run', 'step.jsonl'),
      env: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
    };
    const session = await prepareClaudeSession(input, id);
    await routeClaudeSession(
      { session_id: id, transcript_path: native },
      session.route,
    );
    session.verify();
    expect((await lstat(native)).isSymbolicLink()).toBe(true);
    expect(await readFile(session.route.record, 'utf8')).toBe(
      'native record\n',
    );
    await session.dispose();
    await expect(lstat(native)).rejects.toMatchObject({ code: 'ENOENT' });
    const resumed = await prepareClaudeSession(input, id, true);
    expect(await readFile(native, 'utf8')).toBe('native record\n');
    expect(await readFile(credential, 'utf8')).toBe(
      'credential sentinel, never imported by Rocky',
    );
    await resumed.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
