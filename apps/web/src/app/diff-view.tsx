import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type {
  DiffAnnotation,
  DiffFile,
  DiffView,
} from '@rocky/local-contracts';

import styles from './diff-view.module.css';

export interface DiffViewerProps {
  diff: DiffView;
  onClose: () => void;
}

function labelFor(file: DiffFile) {
  if (file.status === 'renamed' && file.oldPath)
    return `${file.oldPath} → ${file.path}`;
  return file.path;
}

function statusLabel(file: DiffFile) {
  return file.status === 'unavailable' ? 'context unavailable' : file.status;
}

function annotationState(annotation: DiffAnnotation) {
  if (annotation.state === 'fixed') return 'Fixed';
  if (annotation.state === 'open') return 'Open';
  return annotation.state === 'withdrawn' ? 'Withdrawn' : 'Disagreed';
}

function annotationKey(annotation: DiffAnnotation) {
  return `${annotation.id}\u0000${annotation.stepKey}\u0000${annotation.revision}`;
}

function hasLineAnchor(annotation: DiffAnnotation) {
  return annotation.line !== undefined && annotation.side !== undefined;
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  );
}

function filesWithComplaintAnchors(diff: DiffView): DiffFile[] {
  const knownPaths = new Set(diff.files.map((file) => file.path));
  const missingPaths = [
    ...new Set(diff.annotations.map((annotation) => annotation.file)),
  ].filter((path) => !knownPaths.has(path));

  return [
    ...diff.files,
    ...missingPaths.map((path) => {
      const annotations = diff.annotations.filter(
        (annotation) => annotation.file === path,
      );
      return {
        path,
        kind: annotations.some(hasLineAnchor) ? 'missing' : 'directory',
        status: 'unavailable',
        hunks: [],
      } satisfies DiffFile;
    }),
  ];
}

/** A dense, read-only account of one immutable diff revision. */
export function DiffViewer({ diff, onClose }: DiffViewerProps) {
  const files = filesWithComplaintAnchors(diff);
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? '');
  const [focusedComplaint, setFocusedComplaint] = useState<string>();
  const viewerRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    viewerRef.current?.focus();
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  // Polling replaces DiffView values. Keep a person's file and Complaint if they still exist.
  useEffect(() => {
    const nextFiles = filesWithComplaintAnchors(diff);
    setSelectedPath((path) =>
      nextFiles.some((file) => file.path === path)
        ? path
        : (nextFiles[0]?.path ?? ''),
    );
    setFocusedComplaint((key) =>
      diff.annotations.some((annotation) => annotationKey(annotation) === key)
        ? key
        : undefined,
    );
  }, [diff]);

  function restoreFocus() {
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  }

  function closeViewer() {
    restoreFocus();
    onClose();
  }

  function choose(file: DiffFile) {
    setSelectedPath(file.path);
  }

  function moveFile(amount: number) {
    const at = files.findIndex((file) => file.path === selected?.path);
    const next = files[Math.max(0, Math.min(files.length - 1, at + amount))];
    if (next) choose(next);
  }

  function moveComplaint(amount: number) {
    if (!diff.annotations.length) return;
    const focusedIndex =
      focusedComplaint === undefined
        ? -1
        : diff.annotations.findIndex(
            (annotation) => annotationKey(annotation) === focusedComplaint,
          );
    const index =
      focusedIndex < 0
        ? amount > 0
          ? 0
          : diff.annotations.length - 1
        : (focusedIndex + amount + diff.annotations.length) %
          diff.annotations.length;
    const next = diff.annotations[index];
    const nextKey = annotationKey(next);
    const file = files.find((candidate) => candidate.path === next.file);

    setFocusedComplaint(nextKey);
    if (file) choose(file);
    requestAnimationFrame(() => {
      const anchor = anchors.current.get(nextKey);
      anchor?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      anchor?.focus();
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      isTypingTarget(event.target)
    )
      return;
    if (!['j', 'k', 'n', 'p', 'u', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'j') moveFile(1);
    if (event.key === 'k') moveFile(-1);
    if (event.key === 'n') moveComplaint(1);
    if (event.key === 'p') moveComplaint(-1);
    if (event.key === 'u' || event.key === 'Escape') closeViewer();
  }

  return (
    <div
      ref={viewerRef}
      className={styles.viewer}
      tabIndex={0}
      onKeyDownCapture={handleKeyDown}
      aria-label="Diff viewer"
    >
      <header className={styles.topbar}>
        <div>
          <p className={styles.eyebrow}>Diff review</p>
          <h2 className={styles.title}>Revision {diff.id}</h2>
        </div>
        <span className={styles.revisions}>
          {diff.baseSha} → {diff.headSha}
        </span>
        <div
          className={styles.complaintControls}
          aria-label="Complaint navigation"
        >
          <button
            type="button"
            onClick={() => moveComplaint(-1)}
            disabled={!diff.annotations.length}
          >
            Previous Complaint
          </button>
          <button
            type="button"
            onClick={() => moveComplaint(1)}
            disabled={!diff.annotations.length}
          >
            Next Complaint
          </button>
        </div>
        <button
          className={styles.close}
          type="button"
          onClick={closeViewer}
          aria-label="Close diff viewer"
        >
          Close <kbd className={styles.key}>Esc</kbd>
        </button>
      </header>

      {diff.availability === 'pruned' && (
        <section className={styles.unavailable} role="status">
          <h3>Diff content was pruned</h3>
          <p>
            This Run retained its file anchors and Complaints, but the code
            context for revision {diff.id} is no longer available.
          </p>
        </section>
      )}

      <div className={styles.body}>
        <nav className={styles.tree} aria-label="Changed files">
          <p className={styles.treeTitle}>
            Changed files <span>{files.length}</span>
          </p>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => choose(file)}
              className={
                file.path === selected?.path ? styles.selected : undefined
              }
              aria-current={file.path === selected?.path ? 'page' : undefined}
              style={{
                paddingLeft: `${10 + file.path.split('/').length * 12}px`,
              }}
            >
              <span className={`${styles.kind} ${styles[file.status]}`}>
                {file.kind === 'directory'
                  ? '▾'
                  : file.status === 'added'
                    ? '+'
                    : file.status === 'deleted'
                      ? '−'
                      : '•'}
              </span>
              <span className={styles.fileName}>{labelFor(file)}</span>
              <span className={styles.fileState}>{statusLabel(file)}</span>
            </button>
          ))}
        </nav>

        <label className={styles.fileSelectLabel}>
          File
          <select
            value={selected?.path ?? ''}
            onChange={(event) => setSelectedPath(event.target.value)}
            aria-label="Choose changed file"
          >
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {labelFor(file)}
              </option>
            ))}
          </select>
        </label>
        <section className={styles.diffPane} aria-live="polite">
          {selected && (
            <FileDiff
              file={selected}
              annotations={diff.annotations}
              revision={diff.id}
              anchors={anchors}
              hideHunks={diff.availability === 'pruned'}
              onFocusComplaint={setFocusedComplaint}
            />
          )}
          {!selected && (
            <p className={styles.empty}>
              No changed files or Complaint anchors were recorded for this
              revision.
            </p>
          )}
        </section>
      </div>
      <p className={styles.shortcuts}>
        j/k files · n/p Complaints · u or Escape closes
      </p>
    </div>
  );
}

function lineMatches(annotation: DiffAnnotation, file: DiffFile) {
  return (
    hasLineAnchor(annotation) &&
    file.hunks.some((hunk) =>
      hunk.lines.some(
        (line) =>
          (annotation.side === 'base' && annotation.line === line.baseLine) ||
          (annotation.side === 'head' && annotation.line === line.headLine),
      ),
    )
  );
}

function unavailableLineContext(annotation: DiffAnnotation) {
  if (annotation.line === undefined && annotation.side === undefined)
    return undefined;
  if (annotation.line === undefined) {
    return `Line context unavailable: no line number was recorded for the ${annotation.side} side.`;
  }
  if (annotation.side === undefined) {
    return `Line context unavailable: line ${annotation.line} has no recorded base or head side.`;
  }
  return `Line context unavailable: ${annotation.side} line ${annotation.line} was not found in the recorded hunks.`;
}

function FileDiff({
  file,
  annotations,
  revision,
  anchors,
  hideHunks,
  onFocusComplaint,
}: {
  file: DiffFile;
  annotations: DiffAnnotation[];
  revision: string;
  anchors: RefObject<Map<string, HTMLElement>>;
  hideHunks: boolean;
  onFocusComplaint: (key: string) => void;
}) {
  const fileAnnotations = annotations.filter(
    (annotation) => annotation.file === file.path,
  );
  const currentAnnotations = fileAnnotations.filter(
    (annotation) => annotation.revision === revision,
  );
  const historicalAnnotations = fileAnnotations.filter(
    (annotation) => annotation.revision !== revision,
  );
  const matched = currentAnnotations.filter(
    (annotation) => !hideHunks && lineMatches(annotation, file),
  );
  const headerAnnotations = currentAnnotations.filter(
    (annotation) => !matched.includes(annotation),
  );

  return (
    <article className={styles.file}>
      <header className={styles.fileHeader}>
        <div>
          <p className={styles.path}>{labelFor(file)}</p>
          <p className={styles.meta}>
            {file.kind} · {statusLabel(file)}
          </p>
        </div>
        {file.status === 'binary' && (
          <p className={styles.honesty}>
            Binary file — no text diff is available.
          </p>
        )}
        {file.status === 'deleted' && (
          <p className={styles.honesty}>Deleted from the head revision.</p>
        )}
        {file.status === 'unavailable' && (
          <p className={styles.honesty}>
            This file or directory anchor is missing from the recorded diff.
          </p>
        )}
        {file.kind === 'directory' && (
          <p className={styles.honesty}>
            Directory anchor; it has no line-level diff.
          </p>
        )}
        {file.kind === 'missing' && (
          <p className={styles.honesty}>
            The anchored file is missing from this revision.
          </p>
        )}
        {headerAnnotations.map((annotation) => (
          <Annotation
            key={annotationKey(annotation)}
            annotation={annotation}
            anchors={anchors}
            onFocusComplaint={onFocusComplaint}
            context={
              hideHunks
                ? 'Line context unavailable: diff content was pruned.'
                : unavailableLineContext(annotation)
            }
          />
        ))}
        {historicalAnnotations.map((annotation) => (
          <Annotation
            key={annotationKey(annotation)}
            annotation={annotation}
            anchors={anchors}
            onFocusComplaint={onFocusComplaint}
            context={`Old revision ${annotation.revision}: this Complaint is retained at the file header.`}
          />
        ))}
      </header>
      {!hideHunks &&
        file.hunks.map((hunk, hunkIndex) => (
          <section key={`${hunk.header}-${hunkIndex}`} className={styles.hunk}>
            <div className={styles.hunkHeader}>{hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => (
              <DiffLine
                key={lineIndex}
                line={line}
                annotations={matched}
                anchors={anchors}
                onFocusComplaint={onFocusComplaint}
              />
            ))}
          </section>
        ))}
      {!hideHunks && !file.hunks.length && file.status !== 'binary' && (
        <p className={styles.noHunks}>
          No unified hunk was recorded for this anchor.
        </p>
      )}
    </article>
  );
}

function DiffLine({
  line,
  annotations,
  anchors,
  onFocusComplaint,
}: {
  line: DiffFile['hunks'][number]['lines'][number];
  annotations: DiffAnnotation[];
  anchors: RefObject<Map<string, HTMLElement>>;
  onFocusComplaint: (key: string) => void;
}) {
  const attached = annotations.filter(
    (annotation) =>
      (annotation.side === 'base' && annotation.line === line.baseLine) ||
      (annotation.side === 'head' && annotation.line === line.headLine),
  );
  return (
    <>
      <div className={`${styles.line} ${styles[line.kind]}`}>
        <span className={styles.lineNumber}>{line.baseLine ?? ''}</span>
        <span className={styles.lineNumber}>{line.headLine ?? ''}</span>
        <code>
          {line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '}{' '}
          {line.text}
        </code>
      </div>
      {attached.map((annotation) => (
        <Annotation
          key={annotationKey(annotation)}
          annotation={annotation}
          anchors={anchors}
          onFocusComplaint={onFocusComplaint}
        />
      ))}
    </>
  );
}

function Annotation({
  annotation,
  anchors,
  context,
  onFocusComplaint,
}: {
  annotation: DiffAnnotation;
  anchors: RefObject<Map<string, HTMLElement>>;
  context?: string;
  onFocusComplaint: (key: string) => void;
}) {
  const hasReason =
    annotation.state === 'disagreed' || annotation.state === 'withdrawn';
  const key = annotationKey(annotation);
  return (
    <aside
      ref={(element) => {
        if (element) anchors.current.set(key, element);
        else anchors.current.delete(key);
      }}
      tabIndex={-1}
      onFocus={() => onFocusComplaint(key)}
      className={`${styles.annotation} ${styles[annotation.state]}`}
      aria-label={`${annotationState(annotation)} Complaint: ${annotation.text}`}
    >
      <strong>{annotationState(annotation)} Complaint</strong>
      <span>{annotation.text}</span>
      {context && <p className={styles.annotationContext}>{context}</p>}
      {annotation.resolution && (
        <p>
          <b>
            {annotation.state === 'fixed'
              ? `✓ resolved by ${annotation.resolution.label}`
              : `Resolution · ${annotation.resolution.label}`}
          </b>
          {hasReason && annotation.resolution.reason
            ? ` — ${annotation.resolution.reason}`
            : ''}
        </p>
      )}
      {annotation.screenshots?.map((screenshot) => (
        <a
          key={screenshot.id}
          href={`/api/screenshots/${encodeURIComponent(screenshot.id)}`}
        >
          Screenshot: {screenshot.caption}
        </a>
      ))}
    </aside>
  );
}

export default DiffViewer;
