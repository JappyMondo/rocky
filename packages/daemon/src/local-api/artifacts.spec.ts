import {
  link,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffView } from '@rocky/local-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import {
  ArtifactError,
  LocalArtifacts,
  parseUnifiedDiff,
} from './artifacts.js';

const roots: string[] = [];
async function fixture() {
  const root = join(tmpdir(), `rocky-artifacts-${crypto.randomUUID()}`);
  roots.push(root);
  const paths = rockyPaths(root);
  const run = paths.run('NG-609-1');
  await mkdir(run.screenshotsDir, { recursive: true });
  await mkdir(run.sessionsDir, { recursive: true });
  return { paths, run, artifacts: new LocalArtifacts(paths) };
}

async function makeRun(paths: ReturnType<typeof rockyPaths>, runId: string) {
  const run = paths.run(runId);
  await mkdir(run.screenshotsDir, { recursive: true });
  await mkdir(run.sessionsDir, { recursive: true });
  return run;
}

function diff(id: string, annotations: DiffView['annotations'] = []): DiffView {
  return {
    id,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    availability: 'available' as const,
    files: parseUnifiedDiff(
      'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ),
    annotations,
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('LocalArtifacts', () => {
  it('persists opaque screenshots and sniffs the content rather than the extension', async () => {
    const { run, paths, artifacts } = await fixture();
    await writeFile(join(run.screenshotsDir, 'capture.txt'), PNG);
    const shot = await artifacts.registerScreenshot(
      'NG-609-1',
      'capture.txt',
      'proof',
    );
    expect(shot).toEqual({
      id: expect.stringMatching(/^s_[0-9a-f]{32}$/),
      caption: 'proof',
    });
    expect(await artifacts.listScreenshots('NG-609-1')).toEqual([shot]);
    expect(await new LocalArtifacts(paths).readScreenshot(shot.id)).toEqual({
      bytes: PNG,
      contentType: 'image/png',
    });
  });

  it('distinguishes unknown IDs from retention-pruned recorded payloads', async () => {
    const { run, artifacts } = await fixture();
    await writeFile(join(run.screenshotsDir, 'one.png'), PNG);
    const shot = await artifacts.registerScreenshot(
      'NG-609-1',
      'one.png',
      'one',
    );
    await rm(run.screenshotsDir, { recursive: true });
    await expect(artifacts.readScreenshot(shot.id)).rejects.toMatchObject({
      statusCode: 410,
      code: 'screenshot_pruned',
    });
    await expect(
      artifacts.readScreenshot('s_00000000000000000000000000000000'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects traversal, malformed IDs, and symlink escapes', async () => {
    const { run, artifacts } = await fixture();
    await writeFile(join(run.dir, 'outside.png'), PNG);
    await expect(
      artifacts.registerScreenshot('NG-609-1', '../outside.png', 'x'),
    ).rejects.toBeInstanceOf(ArtifactError);
    await expect(artifacts.readScreenshot('../bad')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      artifacts.registerTranscript('NG-609-1', 'agent/0', 'missing.jsonl'),
    ).rejects.toMatchObject({ code: 'invalid_artifact' });
    await symlink(
      join(run.dir, 'outside.png'),
      join(run.screenshotsDir, 'escape.png'),
    );
    await expect(
      artifacts.registerScreenshot('NG-609-1', 'escape.png', 'x'),
    ).rejects.toMatchObject({ code: 'unsafe_artifact_path' });
  });

  it('keeps diff bodies immutable while allowing only annotations to settle', async () => {
    const { artifacts } = await fixture();
    const saved = diff('revision.1');
    await artifacts.saveDiff('NG-609-1', saved);
    await artifacts.saveDiff('NG-609-1', {
      ...saved,
      annotations: [
        {
          id: 'review:0/1',
          stepKey: '1/1/0',
          revision: 'revision.1',
          file: 'a.ts',
          text: 'fixed',
          state: 'fixed',
          resolution: { stepKey: '1/1/1', label: 'fixer 1/5' },
        },
      ],
    });
    await expect(
      artifacts.saveDiff('NG-609-1', { ...saved, headSha: 'c'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'immutable_diff' });
    expect(
      (await artifacts.readDiff('NG-609-1', 'revision.1')).annotations,
    ).toHaveLength(1);
  });

  it('keeps an annotation anchor immutable even when its state settles', async () => {
    const { artifacts } = await fixture();
    const initial = diff('revision.1', [
      {
        id: 'complaint:0/1',
        stepKey: '0/1/0',
        revision: 'revision.1',
        file: 'a.ts',
        line: 2,
        side: 'head',
        text: 'fix it',
        state: 'open',
      },
    ]);
    await artifacts.saveDiff('NG-609-1', initial);
    await artifacts.saveDiff('NG-609-1', {
      ...initial,
      annotations: [
        {
          ...initial.annotations[0],
          state: 'fixed',
          resolution: { stepKey: '0/0/2', label: 'fixed' },
        },
      ],
    });
    await expect(
      artifacts.saveDiff('NG-609-1', {
        ...initial,
        annotations: [
          {
            ...initial.annotations[0],
            file: 'other.ts',
            state: 'fixed',
            resolution: { stepKey: '0/0/2', label: 'fixed' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'immutable_annotation' });
  });

  it('requires complete Resolution metadata and registered screenshot IDs', async () => {
    const { run, artifacts } = await fixture();
    const annotation = {
      id: 'complaint:complete',
      stepKey: '1/0/0',
      revision: 'revision.1',
      file: 'a.ts',
      line: 2,
      side: 'head' as const,
      text: 'This needs a durable reply.',
    };
    await expect(
      artifacts.saveDiff('NG-609-1', {
        ...diff('revision.1'),
        annotations: [{ ...annotation, state: 'fixed' as const }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_diff' });
    await expect(
      artifacts.saveDiff('NG-609-1', {
        ...diff('revision.1'),
        annotations: [
          {
            ...annotation,
            state: 'disagreed' as const,
            resolution: { stepKey: '1/0/1', label: 'fixer 1/5' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_diff' });
    await expect(
      artifacts.saveDiff('NG-609-1', {
        ...diff('revision.1'),
        annotations: [
          {
            ...annotation,
            state: 'fixed' as const,
            resolution: { stepKey: '1/0/1', label: 'fixer 1/5' },
            screenshots: [{ id: 'not-a-screenshot', caption: 'proof' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_diff' });
    await expect(
      artifacts.saveDiff('NG-609-1', {
        ...diff('revision.1'),
        annotations: [
          {
            ...annotation,
            state: 'fixed' as const,
            resolution: { stepKey: '1/0/1', label: 'fixer 1/5' },
            screenshots: [
              { id: `s_${'0'.repeat(32)}`, caption: 'missing proof' },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unknown_screenshot' });
    await writeFile(join(run.screenshotsDir, 'proof.png'), PNG);
    const screenshot = await artifacts.registerScreenshot(
      'NG-609-1',
      'proof.png',
      'proof',
    );
    await expect(
      artifacts.saveDiff('NG-609-1', {
        ...diff('revision.1'),
        annotations: [
          {
            ...annotation,
            state: 'fixed' as const,
            resolution: { stepKey: '1/0/1', label: 'fixer 1/5' },
            screenshots: [screenshot],
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('does not treat inherited manifest keys as artifacts', async () => {
    const { run, artifacts } = await fixture();
    await writeFile(
      join(run.dir, 'artifacts.json'),
      JSON.stringify({
        version: 1,
        screenshots: {},
        transcripts: {},
        diffs: {},
      }),
    );
    await expect(
      artifacts.readDiff('NG-609-1', 'constructor'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'diff_not_found' });
  });

  it('preserves all concurrent artifact registrations across instances', async () => {
    const { paths, run } = await fixture();
    const writers = Array.from({ length: 20 }, () => new LocalArtifacts(paths));
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        await writeFile(join(run.screenshotsDir, `${index}.png`), PNG);
        await writeFile(join(run.sessionsDir, `${index}.jsonl`), '{}\n');
      }),
    );
    await Promise.all(
      writers.flatMap((artifacts, index) => [
        artifacts.registerScreenshot(
          'NG-609-1',
          `${index}.png`,
          `shot ${index}`,
        ),
        artifacts.registerTranscript(
          'NG-609-1',
          `0/0/${index}`,
          `${index}.jsonl`,
        ),
        artifacts.saveDiff('NG-609-1', diff(`revision-${index}`)),
      ]),
    );
    const reader = new LocalArtifacts(paths);
    expect(await reader.listScreenshots('NG-609-1')).toHaveLength(20);
    expect(await reader.listDiffs('NG-609-1')).toHaveLength(20);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        expect(
          reader.transcript('NG-609-1', `0/0/${index}`),
        ).resolves.toBeDefined(),
      ),
    );
  });

  it('marks registered missing transcripts pruned but preserves unsafe-path errors', async () => {
    const { run, artifacts } = await fixture();
    await writeFile(join(run.sessionsDir, 'turn.jsonl'), '{}\n');
    await artifacts.registerTranscript('NG-609-1', '0', 'turn.jsonl');
    await rm(join(run.sessionsDir, 'turn.jsonl'));
    await expect(artifacts.transcript('NG-609-1', '0')).rejects.toMatchObject({
      statusCode: 410,
      code: 'transcript_pruned',
    });
    await writeFile(join(run.dir, 'outside.jsonl'), '{}\n');
    await writeFile(join(run.sessionsDir, 'unsafe.jsonl'), '{}\n');
    await artifacts.registerTranscript('NG-609-1', '1', 'unsafe.jsonl');
    await rm(join(run.sessionsDir, 'unsafe.jsonl'));
    await symlink(
      join(run.dir, 'outside.jsonl'),
      join(run.sessionsDir, 'unsafe.jsonl'),
    );
    await expect(artifacts.transcript('NG-609-1', '1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'unsafe_artifact_path',
    });
  });

  it('refuses artifact roots and Runs redirected by symlinks, including another Run', async () => {
    const { paths, run, artifacts } = await fixture();
    const other = await makeRun(paths, 'NG-609-2');
    await writeFile(join(other.screenshotsDir, 'other.png'), PNG);
    await rm(run.screenshotsDir, { recursive: true });
    await symlink(other.screenshotsDir, run.screenshotsDir);
    await expect(
      artifacts.registerScreenshot('NG-609-1', 'other.png', 'x'),
    ).rejects.toMatchObject({ code: 'unsafe_artifact_root' });
    await rm(run.dir, { recursive: true });
    await symlink(other.dir, run.dir);
    await expect(artifacts.listScreenshots('NG-609-1')).rejects.toMatchObject({
      code: 'unsafe_artifact_root',
    });
  });

  it('ignores non-Run files while locating screenshots and bounds malformed manifests', async () => {
    const { paths, run, artifacts } = await fixture();
    await writeFile(join(paths.runsDir, 'counters.json'), '{}');
    await writeFile(join(run.screenshotsDir, 'one.png'), PNG);
    const shot = await artifacts.registerScreenshot(
      'NG-609-1',
      'one.png',
      'one',
    );
    await expect(artifacts.readScreenshot(shot.id)).resolves.toMatchObject({
      contentType: 'image/png',
    });
    await truncate(join(run.dir, 'artifacts.json'), 20 * 1024 * 1024 + 1);
    await expect(artifacts.listScreenshots('NG-609-1')).rejects.toMatchObject({
      statusCode: 413,
      code: 'manifest_too_large',
    });
  });

  it('rejects malformed manifests and over-limit screenshots before reading them', async () => {
    const { run, artifacts } = await fixture();
    await writeFile(join(run.dir, 'artifacts.json'), '{not json');
    await expect(artifacts.listScreenshots('NG-609-1')).rejects.toMatchObject({
      code: 'invalid_manifest',
    });
    await rm(join(run.dir, 'artifacts.json'));
    await writeFile(join(run.screenshotsDir, 'large.png'), '');
    await truncate(join(run.screenshotsDir, 'large.png'), 20 * 1024 * 1024 + 1);
    await expect(
      artifacts.registerScreenshot('NG-609-1', 'large.png', 'large'),
    ).rejects.toMatchObject({ statusCode: 413, code: 'image_too_large' });
  });

  it('refuses a screenshots root symlinked outside Rocky', async () => {
    const { run, artifacts } = await fixture();
    const outside = join(
      tmpdir(),
      `rocky-artifacts-outside-${crypto.randomUUID()}`,
    );
    roots.push(outside);
    await mkdir(outside);
    await writeFile(join(outside, 'outside.png'), PNG);
    await rm(run.screenshotsDir, { recursive: true });
    await symlink(outside, run.screenshotsDir);
    await expect(
      artifacts.registerScreenshot('NG-609-1', 'outside.png', 'x'),
    ).rejects.toMatchObject({ statusCode: 400, code: 'unsafe_artifact_root' });
  });

  it('refuses hard-linked artifact payloads', async () => {
    const { run, artifacts } = await fixture();
    const outside = join(run.dir, 'outside.png');
    await writeFile(outside, PNG);
    await link(outside, join(run.screenshotsDir, 'linked.png'));
    await expect(
      artifacts.registerScreenshot('NG-609-1', 'linked.png', 'x'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'unsafe_artifact_path',
    });
  });

  it('accepts each allowed image signature', async () => {
    const { run, artifacts } = await fixture();
    const images = [
      ['png', PNG, 'image/png'],
      ['jpeg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
      ['gif', Buffer.from('GIF89a'), 'image/gif'],
      [
        'webp',
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WEBP'),
        ]),
        'image/webp',
      ],
    ] as const;
    for (const [name, bytes, contentType] of images) {
      await writeFile(join(run.screenshotsDir, name), bytes);
      const shot = await artifacts.registerScreenshot('NG-609-1', name, name);
      await expect(artifacts.readScreenshot(shot.id)).resolves.toMatchObject({
        bytes,
        contentType,
      });
    }
  });

  it('parses content that resembles diff headers by hunk counts and preserves rename paths', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/a/file b/a/file',
        'similarity index 100%',
        'rename from a/file',
        'rename to a/renamed',
        '@@ -1,2 +1,2 @@',
        ' context source text',
        '--- removed source text',
        '+++ added source text',
      ].join('\n'),
    );
    expect(files).toEqual([
      {
        path: 'a/renamed',
        oldPath: 'a/file',
        kind: 'file',
        status: 'renamed',
        hunks: [
          {
            header: '@@ -1,2 +1,2 @@',
            lines: [
              {
                kind: 'context',
                text: 'context source text',
                baseLine: 1,
                headLine: 1,
              },
              { kind: 'delete', text: '-- removed source text', baseLine: 2 },
              { kind: 'add', text: '++ added source text', headLine: 2 },
            ],
          },
        ],
      },
    ]);
  });
});
