import { memo, useEffect, useRef, useState } from 'react';
import type { StepView } from '@rocky/local-contracts';
import {
  TranscriptDecoder,
  type Activity,
  type Transcript,
} from './transcript.js';
import { CodeOutput, OutputValue } from './output-view.js';
import styles from './output-view.module.css';

const Entry = memo(function Entry({ item }: { item: Activity }) {
  const [expanded, setExpanded] = useState(false);
  const stamp =
    item.time !== undefined && Number.isFinite(new Date(item.time).getTime())
      ? new Date(item.time).toLocaleTimeString()
      : undefined;
  const heading = (
    <>
      <span className={styles.kind}>
        {item.kind === 'tool' ? '↳' : item.kind === 'message' ? '✦' : '·'}
      </span>
      <strong>{item.title}</strong>
      {item.kind === 'tool' && item.text && (
        <span className={styles.toolTitle}>{item.text}</span>
      )}
      {item.status && (
        <span className={styles.badge} data-status={item.status}>
          {item.status === 'completed'
            ? 'Done'
            : item.status === 'error'
              ? 'Failed'
              : 'Running'}
        </span>
      )}
      <span className={styles.time}>
        {item.ms !== undefined && `${(item.ms / 1000).toFixed(1)}s`}
        {stamp && <time>{stamp}</time>}
      </span>
    </>
  );
  const body = (
    <>
      {item.text && item.kind !== 'tool' && (
        <OutputValue value={item.text} code={item.kind === 'output'} />
      )}
      {item.input !== undefined && (
        <section>
          <h5>Input</h5>
          <OutputValue value={item.input} code />
        </section>
      )}
      {item.output !== undefined && (
        <section>
          <h5>Output</h5>
          <OutputValue value={item.output} code />
        </section>
      )}
      {item.data !== undefined && <OutputValue value={item.data} />}
    </>
  );
  return (
    <article
      className={styles.entry}
      data-kind={item.kind}
      data-status={item.status}
    >
      {item.kind === 'message' ||
      item.kind === 'error' ||
      (item.kind === 'output' && item.title === 'Output') ? (
        <>
          <header>{heading}</header>
          <div className={styles.entryBody}>{body}</div>
        </>
      ) : (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>{heading}</summary>
          {expanded && <div className={styles.entryBody}>{body}</div>}
        </details>
      )}
    </article>
  );
});
export function TranscriptView({
  transcript,
  state,
  empty,
}: {
  transcript: Transcript;
  state: 'loading' | 'settled' | 'unavailable' | 'error';
  empty: string;
}) {
  const [mode, setMode] = useState('Activity');
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(80);
  const [follow, setFollow] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const matched = transcript.items.filter(
    (item) =>
      (filter === 'All' ||
        (filter === 'Tools'
          ? item.kind === 'tool'
          : filter === 'Messages'
            ? item.kind === 'message' || item.kind === 'reasoning'
            : item.kind === 'error' || item.status === 'error')) &&
      (!query ||
        JSON.stringify(item).toLowerCase().includes(query.toLowerCase())),
  );
  useEffect(() => {
    if (follow && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [transcript, follow, mode]);
  return (
    <section className={styles.transcript} aria-label="Transcript">
      <header className={styles.toolbar}>
        <div>
          <strong>Transcript</strong>
          <span className={styles.streamState} role="status">
            {state === 'settled'
              ? 'Complete'
              : state === 'error'
                ? 'Connection interrupted'
                : state === 'unavailable'
                  ? 'Unavailable'
                  : 'Receiving'}
          </span>
        </div>
        <div className={styles.segment} aria-label="Transcript view">
          {['Activity', 'Raw'].map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={mode === name}
              onClick={() => setMode(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </header>
      {mode === 'Activity' && (
        <div className={styles.filters}>
          <div className={styles.segment} aria-label="Filter transcript">
            {['All', 'Messages', 'Tools', 'Errors'].map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={filter === name}
                onClick={() => {
                  setFilter(name);
                  setLimit(80);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <input
            type="search"
            aria-label="Search transcript"
            placeholder="Search activity…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(80);
            }}
          />
        </div>
      )}
      {(state === 'error' || state === 'unavailable') && (
        <p className={styles.notice}>
          {empty}{' '}
          {transcript.items.length
            ? 'Previously received activity is shown below.'
            : ''}
        </p>
      )}
      {!!transcript.omitted && (
        <p className={styles.notice}>
          {transcript.omitted.toLocaleString()} earlier entries omitted from
          this browser view. The retained transcript is unchanged.
        </p>
      )}
      <div className={styles.viewport} ref={viewport}>
        {mode === 'Raw' ? (
          <>
            {transcript.rawTruncated && (
              <p className={styles.notice}>
                Showing the last 200,000 raw characters.
              </p>
            )}
            <CodeOutput text={transcript.raw || empty} />
          </>
        ) : (
          <>
            {matched.length > limit && (
              <button
                type="button"
                className={styles.earlier}
                onClick={() => setLimit(limit + 80)}
              >
                Show {Math.min(80, matched.length - limit)} earlier entries
              </button>
            )}
            {matched.slice(-limit).map((item) => (
              <Entry key={item.id} item={item} />
            ))}
            {!matched.length &&
              state !== 'error' &&
              state !== 'unavailable' && (
                <p className={styles.empty}>
                  {transcript.items.length ? 'No matching activity.' : empty}
                </p>
              )}
            {transcript.pending && (
              <p className={styles.empty}>Receiving the next event…</p>
            )}
          </>
        )}
      </div>
      <footer className={styles.feedFooter}>
        <span>
          {matched.length} {matched.length === 1 ? 'entry' : 'entries'}
          {query || filter !== 'All' ? ' matched' : ''}
        </span>
        <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />{' '}
          Follow latest
        </label>
      </footer>
    </section>
  );
}
export function TranscriptPanel({
  runId,
  step,
}: {
  runId: string;
  step: StepView;
}) {
  const decoder = useRef(new TranscriptDecoder());
  const [transcript, setTranscript] = useState(() =>
    decoder.current.snapshot(),
  );
  const [state, setState] = useState<
    'loading' | 'settled' | 'unavailable' | 'error'
  >('loading');
  const offset = useRef(0);
  useEffect(() => {
    let source: EventSource | undefined;
    try {
      source = new EventSource(
        `/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.key)}/transcript?offset=${offset.current}`,
      );
      source.addEventListener('transcript', (event) => {
        try {
          const value = JSON.parse((event as MessageEvent<string>).data) as {
            text?: unknown;
            offset?: unknown;
          };
          if (
            typeof value.text !== 'string' ||
            typeof value.offset !== 'number' ||
            !Number.isSafeInteger(value.offset) ||
            value.offset <= offset.current
          )
            return;
          offset.current = value.offset;
          setTranscript(decoder.current.push(value.text));
          setState('loading');
        } catch {
          setState('error');
        }
      });
      source.addEventListener('settled', () => {
        setTranscript(decoder.current.finish());
        setState('settled');
        source?.close();
      });
      source.addEventListener('unavailable', () => {
        setState('unavailable');
        source?.close();
      });
      source.onerror = () => {
        setState('error');
        // EventSource reconnects live Steps using its byte offset / Last-Event-ID.
        if (step.status !== 'running') {
          setTranscript(decoder.current.finish());
          source?.close();
        }
      };
    } catch {
      setState('error');
    }
    return () => source?.close();
  }, [runId, step.key, step.status]);
  const empty =
    state === 'unavailable'
      ? 'Transcript is unavailable.'
      : state === 'error'
        ? 'Transcript could not be read.'
        : state === 'settled'
          ? 'No transcript output was recorded.'
          : step.transcript === 'pending'
            ? 'Transcript is still being written…'
            : 'Loading transcript…';
  return <TranscriptView transcript={transcript} state={state} empty={empty} />;
}
