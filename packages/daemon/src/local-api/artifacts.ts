import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  DiffFile,
  DiffView,
  Screenshot,
  ReviewReport,
} from '@rocky/local-contracts';
import type { RockyPaths } from '../config/paths.js';
import { PUBLIC_MODE, writeAtomic } from '../atomic-write.js';
import { StoredReport } from '../review-report/schema.js';
import { KeyedMutex } from '../repos/mutex.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024;
const MANIFEST = 'artifacts.json';
const SHOT_ID = /^s_[0-9a-f]{32}$/;
const DIFF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STEP_KEY = /^\d+(?:\/\d+\/\d+)*$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const manifestUpdates = new KeyedMutex();

export class ArtifactError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 410 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

interface Manifest {
  version: 1;
  screenshots: Record<string, { relativePath: string; caption: string }>;
  transcripts: Record<string, string>;
  diffs: Record<string, DiffView>;
  reports: Record<string, ReviewReport>;
}

const emptyManifest = (): Manifest => ({
  version: 1,
  screenshots: Object.create(null),
  transcripts: Object.create(null),
  diffs: Object.create(null),
  reports: Object.create(null),
});

function fail(
  code: string,
  message: string,
  statusCode: 400 | 404 | 410 | 413 = 400,
): never {
  throw new ArtifactError(statusCode, code, message);
}

function normalRelative(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes('\0') &&
    !isAbsolute(value) &&
    !value
      .split(/[\\/]/)
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return (
    rel !== '' &&
    !rel.startsWith(`..${sep}`) &&
    rel !== '..' &&
    !isAbsolute(rel)
  );
}

function imageType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
      bytes.subarray(0, 6).equals(Buffer.from('GIF89a')))
  )
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
  )
    return 'image/webp';
  return undefined;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function assertString(
  value: unknown,
  name: string,
  max = 16_384,
): asserts value is string {
  if (typeof value !== 'string' || value.length > max)
    fail('invalid_artifact', `${name} is invalid`);
}

function assertBoundedNonemptyString(
  value: unknown,
  name: string,
  max = 1024,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  )
    fail('invalid_artifact', `${name} is invalid`);
}

function assertStepKey(
  value: unknown,
  name: string,
  code = 'invalid_diff',
): void {
  if (typeof value !== 'string' || !STEP_KEY.test(value))
    fail(code, `${name} is invalid`);
}

function assertResolution(value: unknown, state: unknown): void {
  if (value === undefined) {
    if (state !== 'open')
      fail('invalid_diff', 'Settled Complaint needs a Resolution');
    return;
  }
  if (!plainRecord(value)) fail('invalid_diff', 'Resolution is invalid');
  assertStepKey(value.stepKey, 'Resolution Step key');
  assertBoundedNonemptyString(value.label, 'Resolution label');
  if (value.reason !== undefined)
    assertBoundedNonemptyString(value.reason, 'Resolution reason', 16_384);
  if (state === 'disagreed' && typeof value.reason !== 'string')
    fail('invalid_diff', 'Disagreement needs a Resolution reason');
}

function assertScreenshots(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 1_000)
    fail('invalid_diff', 'Diff screenshots are invalid');
  for (const screenshot of value) {
    if (
      !plainRecord(screenshot) ||
      typeof screenshot.id !== 'string' ||
      !SHOT_ID.test(screenshot.id)
    )
      fail('invalid_diff', 'Diff screenshot is invalid');
    assertString(screenshot.caption, 'Diff screenshot caption');
  }
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isSymlink(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ELOOP'
  );
}

async function readBounded(
  path: string,
  maxBytes: number,
  tooLargeCode: string,
  tooLargeMessage: string,
): Promise<{ bytes: Buffer; isFile: boolean }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (isSymlink(error))
      fail('unsafe_artifact_path', 'Artifact path must not be a symlink');
    throw error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) return { bytes: Buffer.alloc(0), isFile: false };
    if (info.nlink !== 1)
      fail('unsafe_artifact_path', 'Artifact file must not be hard-linked');
    if (info.size > maxBytes) fail(tooLargeCode, tooLargeMessage, 413);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      bytes: offset === bytes.length ? bytes : bytes.subarray(0, offset),
      isFile: true,
    };
  } finally {
    await file.close();
  }
}

async function assertRegularArtifact(
  path: string,
  code: string,
  message: string,
): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (isSymlink(error))
      fail('unsafe_artifact_path', 'Artifact path must not be a symlink');
    throw error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) fail(code, message);
    if (info.nlink !== 1)
      fail('unsafe_artifact_path', 'Artifact file must not be hard-linked');
  } finally {
    await file.close();
  }
}

function assertDiff(diff: DiffView): void {
  if (
    !diff ||
    typeof diff !== 'object' ||
    !DIFF_ID.test(diff.id) ||
    !SHA.test(diff.baseSha) ||
    !SHA.test(diff.headSha)
  )
    fail('invalid_diff', 'Diff identity is invalid');
  if (diff.availability !== 'available' && diff.availability !== 'pruned')
    fail('invalid_diff', 'Diff availability is invalid');
  if (
    !Array.isArray(diff.files) ||
    diff.files.length > 10_000 ||
    !Array.isArray(diff.annotations) ||
    diff.annotations.length > 100_000
  )
    fail('invalid_diff', 'Diff is too large');
  for (const file of diff.files) {
    if (
      !file ||
      !normalRelative(file.path) ||
      (file.oldPath !== undefined && !normalRelative(file.oldPath)) ||
      !['file', 'directory', 'missing'].includes(file.kind) ||
      ![
        'modified',
        'added',
        'deleted',
        'renamed',
        'binary',
        'unavailable',
      ].includes(file.status) ||
      !Array.isArray(file.hunks) ||
      file.hunks.length > 100_000
    )
      fail('invalid_diff', 'Diff file is invalid');
    for (const hunk of file.hunks) {
      if (
        !hunk ||
        typeof hunk.header !== 'string' ||
        hunk.header.length > 16_384 ||
        !Array.isArray(hunk.lines) ||
        hunk.lines.length > 100_000
      )
        fail('invalid_diff', 'Diff hunk is invalid');
      for (const line of hunk.lines)
        if (
          !line ||
          !['context', 'add', 'delete'].includes(line.kind) ||
          typeof line.text !== 'string' ||
          line.text.length > 1_000_000 ||
          (line.baseLine !== undefined &&
            (!Number.isSafeInteger(line.baseLine) || line.baseLine < 0)) ||
          (line.headLine !== undefined &&
            (!Number.isSafeInteger(line.headLine) || line.headLine < 0))
        )
          fail('invalid_diff', 'Diff line is invalid');
    }
  }
  const annotationIds = new Set<string>();
  for (const annotation of diff.annotations) {
    if (!annotation || typeof annotation !== 'object')
      fail('invalid_diff', 'Diff annotation is invalid');
    assertBoundedNonemptyString(annotation.id, 'annotation ID');
    if (
      annotationIds.has(annotation.id) ||
      typeof annotation.stepKey !== 'string' ||
      !STEP_KEY.test(annotation.stepKey) ||
      annotation.revision !== diff.id ||
      !normalRelative(annotation.file) ||
      typeof annotation.text !== 'string' ||
      annotation.text.length > 1_000_000 ||
      !['open', 'fixed', 'disagreed', 'withdrawn'].includes(annotation.state) ||
      (annotation.side !== undefined &&
        annotation.side !== 'base' &&
        annotation.side !== 'head') ||
      (annotation.line !== undefined &&
        (!Number.isSafeInteger(annotation.line) || annotation.line < 1))
    )
      fail('invalid_diff', 'Diff annotation is invalid');
    assertResolution(annotation.resolution, annotation.state);
    assertScreenshots(annotation.screenshots);
    annotationIds.add(annotation.id);
  }
  if (Buffer.byteLength(stable(diff)) > MAX_JSON_BYTES)
    fail('diff_too_large', 'Diff is too large', 413);
}

/** Local, durable artifacts. It never accepts a filesystem path from a reader. */
export class LocalArtifacts {
  constructor(private readonly paths: RockyPaths) {}

  async saveReport(runId: string, report: ReviewReport): Promise<void> {
    const checked = StoredReport.parse(report);
    if (checked.runId !== runId)
      fail('invalid_report', 'Report belongs to another Run');
    await this.update(runId, (manifest) => {
      for (const visual of checked.visuals)
        for (const screenshot of visual.screenshots)
          if (!own(manifest.screenshots, screenshot.id))
            fail(
              'unknown_screenshot',
              'Report references an unregistered screenshot',
            );
      const previous = own(manifest.reports, checked.id);
      if (previous && stable(previous) !== stable(checked))
        fail('immutable_report', 'A report revision cannot be overwritten');
      manifest.reports[checked.id] = checked;
    });
  }

  async listReports(runId: string): Promise<ReviewReport[]> {
    return Object.values((await this.load(runId)).reports);
  }

  async readReport(runId: string, id: string): Promise<ReviewReport> {
    if (!/^r_[0-9a-f]{32}$/.test(id))
      fail('invalid_report', 'Report ID is malformed');
    const report = own((await this.load(runId)).reports, id);
    if (!report) fail('report_not_found', 'Report was not found', 404);
    return report;
  }

  async snapshotScreenshot(
    runId: string,
    relativePath: string,
    caption: string,
  ): Promise<Screenshot> {
    const source = await this.registerScreenshot(runId, relativePath, caption);
    const { bytes, contentType } = await this.readScreenshot(source.id);
    const filename = `review-${createHash('sha256').update(bytes).digest('hex')}.${contentType.split('/')[1]}`;
    // Source registration has already verified that the screenshot root is confined.
    const root = await realpath(this.paths.run(runId).screenshotsDir);
    await writeAtomic(resolve(root, filename), bytes, PUBLIC_MODE);
    return this.registerScreenshot(runId, filename, caption);
  }

  async registerScreenshot(
    runId: string,
    relativePath: string,
    caption: string,
  ): Promise<Screenshot> {
    this.assertRunId(runId);
    if (!normalRelative(relativePath))
      fail('invalid_path', 'Screenshot path must be a normal relative path');
    assertString(caption, 'caption');
    const path = await this.confinedExisting(
      runId,
      'screenshotsDir',
      relativePath,
    );
    const { bytes, isFile } = await readBounded(
      path,
      MAX_BYTES,
      'image_too_large',
      'Screenshot exceeds 20 MiB',
    );
    if (!isFile) fail('invalid_image', 'Screenshot is not a file');
    if (!imageType(bytes))
      fail(
        'invalid_image',
        'Screenshot must be a PNG, JPEG, GIF, or WebP image',
      );
    const id = `s_${createHash('sha256').update(runId).update('\0').update(relativePath).digest('hex').slice(0, 32)}`;
    await this.update(runId, async (manifest) => {
      manifest.screenshots[id] = { relativePath, caption };
    });
    return { id, caption };
  }

  async readScreenshot(
    id: string,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    if (!SHOT_ID.test(id))
      fail('invalid_screenshot_id', 'Screenshot ID is malformed');
    // IDs include the run hash only indirectly; find the one recorded owner, never a caller path.
    const runs = await this.safeRunDirs();
    for (const runId of runs) {
      const manifest = await this.load(runId);
      const entry = own(manifest.screenshots, id);
      if (!entry) continue;
      let path: string;
      try {
        path = await this.confinedExisting(
          runId,
          'screenshotsDir',
          entry.relativePath,
        );
      } catch (error) {
        if (error instanceof ArtifactError && error.code.startsWith('unsafe_'))
          throw error;
        if (error instanceof ArtifactError)
          throw new ArtifactError(
            410,
            'screenshot_pruned',
            'Screenshot has been pruned',
          );
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          throw new ArtifactError(
            410,
            'screenshot_pruned',
            'Screenshot has been pruned',
          );
        throw error;
      }
      let stored;
      try {
        stored = await readBounded(
          path,
          MAX_BYTES,
          'image_too_large',
          'Screenshot exceeds 20 MiB',
        );
      } catch (error) {
        if (isMissing(error))
          throw new ArtifactError(
            410,
            'screenshot_pruned',
            'Screenshot has been pruned',
          );
        throw error;
      }
      if (!stored.isFile)
        throw new ArtifactError(
          410,
          'screenshot_pruned',
          'Screenshot has been pruned',
        );
      const { bytes } = stored;
      const contentType = imageType(bytes);
      if (!contentType)
        fail('invalid_image', 'Stored screenshot is not an allowed image');
      return { bytes, contentType };
    }
    fail('screenshot_not_found', 'Screenshot was not found', 404);
  }

  async listScreenshots(runId: string): Promise<Screenshot[]> {
    const manifest = await this.load(runId);
    return Object.entries(manifest.screenshots).map(([id, entry]) => ({
      id,
      caption: entry.caption,
    }));
  }

  async saveDiff(runId: string, diff: DiffView): Promise<void> {
    this.assertRunId(runId);
    assertDiff(diff);
    await this.update(runId, async (manifest) => {
      for (const annotation of diff.annotations)
        for (const screenshot of annotation.screenshots ?? [])
          if (!own(manifest.screenshots, screenshot.id))
            fail(
              'unknown_screenshot',
              'Diff annotation references an unregistered screenshot',
            );
      const previous = own(manifest.diffs, diff.id);
      if (previous) {
        if (
          previous.baseSha !== diff.baseSha ||
          previous.headSha !== diff.headSha ||
          stable(previous.files) !== stable(diff.files) ||
          previous.availability !== diff.availability
        )
          fail('immutable_diff', 'A diff revision cannot be overwritten');
        const next = new Map(
          diff.annotations.map((annotation) => [annotation.id, annotation]),
        );
        for (const annotation of previous.annotations) {
          const replacement = next.get(annotation.id);
          if (
            !replacement ||
            stable({
              ...replacement,
              state: annotation.state,
              resolution: annotation.resolution,
            }) !== stable(annotation)
          ) {
            fail(
              'immutable_annotation',
              'Only an annotation state and resolution may change',
            );
          }
        }
      }
      manifest.diffs[diff.id] = previous
        ? { ...previous, annotations: diff.annotations }
        : diff;
    });
  }

  async listDiffs(
    runId: string,
  ): Promise<
    Array<{ id: string; label: string; baseSha: string; headSha: string }>
  > {
    const manifest = await this.load(runId);
    return Object.values(manifest.diffs).map((diff) => ({
      id: diff.id,
      label: diff.id,
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    }));
  }

  async readDiff(runId: string, id: string): Promise<DiffView> {
    this.assertRunId(runId);
    if (!DIFF_ID.test(id)) fail('invalid_diff_id', 'Diff ID is malformed');
    const diff = own((await this.load(runId)).diffs, id);
    if (!diff) fail('diff_not_found', 'Diff was not found', 404);
    return diff;
  }

  async transcript(
    runId: string,
    stepKey: string,
  ): Promise<{ path: string } | undefined> {
    this.assertRunId(runId);
    assertStepKey(stepKey, 'Transcript Step key', 'invalid_artifact');
    const entry = own((await this.load(runId)).transcripts, stepKey);
    if (!entry) return undefined;
    try {
      const path = await this.confinedExisting(runId, 'sessionsDir', entry);
      await assertRegularArtifact(
        path,
        'invalid_transcript',
        'Transcript is not a file',
      );
      return { path };
    } catch (error) {
      if (isMissing(error))
        throw new ArtifactError(
          410,
          'transcript_pruned',
          'Transcript has been pruned',
        );
      throw error;
    }
  }

  async registerTranscript(
    runId: string,
    stepKey: string,
    relativePath: string,
  ): Promise<void> {
    this.assertRunId(runId);
    assertStepKey(stepKey, 'Transcript Step key', 'invalid_artifact');
    if (!normalRelative(relativePath))
      fail('invalid_path', 'Transcript path must be a normal relative path');
    const path = await this.confinedExisting(
      runId,
      'sessionsDir',
      relativePath,
    );
    await assertRegularArtifact(
      path,
      'invalid_transcript',
      'Transcript is not a file',
    );
    await this.update(runId, async (manifest) => {
      manifest.transcripts[stepKey] = relativePath;
    });
  }

  private assertRunId(runId: string): void {
    try {
      this.paths.run(runId);
    } catch {
      fail('invalid_run_id', 'Run ID is malformed');
    }
  }

  private async safeRunDirs(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    try {
      return (
        await readdir(this.paths.runsDir, { withFileTypes: true })
      ).flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        try {
          this.paths.run(entry.name);
          return [entry.name];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async confinedExisting(
    runId: string,
    key: 'screenshotsDir' | 'sessionsDir',
    relativePath: string,
  ): Promise<string> {
    const run = this.paths.run(runId);
    const canonicalRun = await this.canonicalRun(runId);
    const base = await realpath(run[key]);
    const expectedBase = resolve(
      canonicalRun,
      key === 'screenshotsDir' ? 'screenshots' : 'sessions',
    );
    if (base !== expectedBase)
      fail('unsafe_artifact_root', 'Artifact directory escapes its run');
    const target = await realpath(resolve(base, relativePath));
    if (!within(base, target))
      fail('unsafe_artifact_path', 'Artifact path escapes its directory');
    return target;
  }

  private async load(runId: string): Promise<Manifest> {
    this.assertRunId(runId);
    const canonicalRun = await this.canonicalRun(runId);
    const manifestPath = resolve(canonicalRun, MANIFEST);
    let text: string;
    try {
      // A manifest is also input. Do not follow a symlink out of the Run.
      const canonicalManifest = await realpath(manifestPath);
      if (canonicalManifest !== manifestPath)
        fail('unsafe_artifact_path', 'Artifact manifest escapes its run');
      const stored = await readBounded(
        canonicalManifest,
        MAX_JSON_BYTES,
        'manifest_too_large',
        'Artifact manifest is too large',
      );
      if (!stored.isFile)
        fail('invalid_manifest', 'Artifact manifest is invalid');
      text = stored.bytes.toString('utf8');
    } catch (error) {
      if (isMissing(error)) return emptyManifest();
      throw error;
    }
    if (Buffer.byteLength(text) > MAX_JSON_BYTES)
      fail('manifest_too_large', 'Artifact manifest is too large', 413);
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      fail('invalid_manifest', 'Artifact manifest is invalid');
    }
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      (manifest as Manifest).version !== 1 ||
      !plainRecord((manifest as Manifest).screenshots) ||
      !plainRecord((manifest as Manifest).transcripts) ||
      !plainRecord((manifest as Manifest).diffs)
    )
      fail('invalid_manifest', 'Artifact manifest is invalid');
    const checked = manifest as Manifest;
    if (checked.reports !== undefined && !plainRecord(checked.reports))
      fail('invalid_manifest', 'Invalid report manifest');
    for (const [id, report] of Object.entries(checked.reports ?? {})) {
      if (
        id !== report.id ||
        report.runId !== runId ||
        !StoredReport.safeParse(report).success
      )
        fail('invalid_manifest', 'Invalid report');
    }
    if (
      Object.keys(checked.screenshots).length > 100_000 ||
      Object.keys(checked.transcripts).length > 100_000 ||
      Object.keys(checked.diffs).length > 10_000
    )
      fail('manifest_too_large', 'Artifact manifest is too large', 413);
    for (const [id, screenshot] of Object.entries(checked.screenshots))
      if (
        !SHOT_ID.test(id) ||
        !screenshot ||
        !normalRelative(screenshot.relativePath) ||
        typeof screenshot.caption !== 'string' ||
        screenshot.caption.length > 16_384
      )
        fail('invalid_manifest', 'Artifact manifest is invalid');
    for (const [stepKey, transcript] of Object.entries(checked.transcripts))
      if (!STEP_KEY.test(stepKey) || !normalRelative(transcript))
        fail('invalid_manifest', 'Artifact manifest is invalid');
    for (const [id, diff] of Object.entries(checked.diffs))
      if (id !== diff?.id)
        fail('invalid_manifest', 'Artifact manifest is invalid');
      else assertDiff(diff);
    return {
      version: 1,
      screenshots: Object.assign(Object.create(null), checked.screenshots),
      transcripts: Object.assign(Object.create(null), checked.transcripts),
      diffs: Object.assign(Object.create(null), checked.diffs),
      reports: Object.assign(Object.create(null), checked.reports ?? {}),
    };
  }

  private async save(runId: string, manifest: Manifest): Promise<void> {
    const canonicalRun = await this.canonicalRun(runId);
    await writeAtomic(
      resolve(canonicalRun, MANIFEST),
      `${JSON.stringify(manifest)}\n`,
      PUBLIC_MODE,
    );
  }

  private async update(
    runId: string,
    mutation: (manifest: Manifest) => Promise<void> | void,
  ): Promise<void> {
    const canonicalRun = await this.canonicalRun(runId);
    await manifestUpdates.run(resolve(canonicalRun, MANIFEST), async () => {
      const manifest = await this.load(runId);
      await mutation(manifest);
      await this.save(runId, manifest);
    });
  }

  private async canonicalRun(runId: string): Promise<string> {
    const run = this.paths.run(runId);
    const canonicalRoot = await realpath(this.paths.root);
    const canonicalRuns = await realpath(this.paths.runsDir);
    const canonicalRun = await realpath(run.dir);
    const expectedRuns = resolve(canonicalRoot, 'runs');
    const expectedRun = resolve(expectedRuns, runId);
    if (canonicalRuns !== expectedRuns || canonicalRun !== expectedRun)
      fail('unsafe_artifact_root', 'Run directory escapes Rocky root');
    return canonicalRun;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function diffPath(value: string | undefined): string | undefined {
  if (!value || value === '/dev/null') return undefined;
  const stripped = value.replace(/^[ab]\//, '');
  return normalRelative(stripped) ? stripped : undefined;
}

function renamePath(value: string | undefined): string | undefined {
  return value && normalRelative(value) ? value : undefined;
}

/** Parses ordinary `git diff --no-ext-diff` unified output without invoking git. */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_JSON_BYTES)
    fail('invalid_diff', 'Patch is invalid or too large');
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let hunk: DiffFile['hunks'][number] | undefined;
  let base = 0;
  let head = 0;
  let baseRemaining = 0;
  let headRemaining = 0;
  for (const line of patch.split(/\n/)) {
    if (line.startsWith('diff --git ')) {
      const match =
        /^diff --git (?:"a\/(.*)"|a\/(.*)) (?:"b\/(.*)"|b\/(.*))$/.exec(line);
      const path = diffPath(match?.[3] ?? match?.[4]);
      const oldPath = diffPath(match?.[1] ?? match?.[2]);
      if (!path || !oldPath)
        fail('invalid_diff_path', 'Patch contains an invalid path');
      current = {
        path,
        oldPath: path === oldPath ? undefined : oldPath,
        kind: 'file',
        status: path === oldPath ? 'modified' : 'renamed',
        hunks: [],
      };
      files.push(current);
      hunk = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode ')) current.status = 'added';
    else if (line.startsWith('deleted file mode ')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      const old = renamePath(line.slice(12));
      if (!old) fail('invalid_diff_path', 'Patch contains an invalid rename');
      current.oldPath = old;
      current.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      const path = renamePath(line.slice(10));
      if (!path) fail('invalid_diff_path', 'Patch contains an invalid rename');
      current.path = path;
      current.status = 'renamed';
    } else if (
      line.startsWith('Binary files ') ||
      line === 'GIT binary patch'
    ) {
      current.status = 'binary';
      current.hunks = [];
      hunk = undefined;
    } else {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header) {
        base = Number(header[1]);
        head = Number(header[3]);
        baseRemaining = header[2] === undefined ? 1 : Number(header[2]);
        headRemaining = header[4] === undefined ? 1 : Number(header[4]);
        hunk = { header: line, lines: [] };
        current.hunks.push(hunk);
      } else if (
        hunk &&
        (baseRemaining > 0 || headRemaining > 0) &&
        /^[ +-]/.test(line)
      ) {
        const marker = line[0];
        const item: DiffFile['hunks'][number]['lines'][number] = {
          kind: marker === '+' ? 'add' : marker === '-' ? 'delete' : 'context',
          text: line.slice(1),
        };
        if (
          (marker === ' ' && (baseRemaining === 0 || headRemaining === 0)) ||
          (marker === '-' && baseRemaining === 0) ||
          (marker === '+' && headRemaining === 0)
        )
          continue;
        if (marker !== '+') {
          item.baseLine = base++;
          baseRemaining--;
        }
        if (marker !== '-') {
          item.headLine = head++;
          headRemaining--;
        }
        hunk.lines.push(item);
      }
    }
  }
  return files;
}
