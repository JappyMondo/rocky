import { useEffect, useRef, useState } from 'react';
import type { WorkflowDiagramView } from '@rocky/local-contracts';
import { api, apiError } from './api.js';
import { Dialog } from './ui.js';
import styles from './app.module.css';

let sequence = 0;

function Chart({ source }: { source: string }) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(100);
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    setImage(undefined);
    setError(false);
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;';
    document.body.append(container);
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        if (stopped) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          suppressErrorRendering: true,
          maxTextSize: 16000,
          layout: 'dagre',
          theme: 'base',
          themeVariables: {
            primaryColor: '#edf3e5',
            primaryTextColor: '#26331e',
            primaryBorderColor: '#a0b488',
            lineColor: '#78886b',
            secondaryColor: '#faf6e9',
            tertiaryColor: '#f5f7f1',
            fontFamily: 'Arial, sans-serif',
            fontSize: '15px',
          },
          flowchart: { inheritDir: true, curve: 'basis', useMaxWidth: false },
        });
        const { svg } = await mermaid.render(
          `workflow-diagram-${++sequence}`,
          source,
          container,
        );
        if (!stopped)
          setImage(
            `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          );
      } catch {
        if (!stopped) setError(true);
      } finally {
        container.remove();
      }
    })();
    return () => {
      stopped = true;
      container.remove();
    };
  }, [source]);
  if (error)
    return (
      <p role="alert" className={styles.error}>
        This diagram could not be drawn. Regenerate it to try again.
      </p>
    );
  if (!image)
    return (
      <p role="status" className={styles.muted}>
        Drawing workflow…
      </p>
    );
  return (
    <>
      <div className={styles.diagramZoom} aria-label="Diagram zoom">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={zoom <= 50}
          onClick={() => setZoom(zoom - 25)}
        >
          −
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(100);
            if (canvas.current) {
              canvas.current.scrollLeft = 0;
              canvas.current.scrollTop = 0;
            }
          }}
        >
          Fit diagram
        </button>
        <span>{zoom}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={zoom >= 300}
          onClick={() => setZoom(zoom + 25)}
        >
          +
        </button>
      </div>
      <div
        ref={canvas}
        className={styles.diagramCanvas}
        tabIndex={0}
        aria-label="Workflow chart, scroll to explore"
      >
        <div
          className={styles.diagramStage}
          style={{
            width: `${zoom}%`,
            height: `${zoom}%`,
          }}
        >
          <img src={image} alt="Workflow stages, decisions and outcomes" />
        </div>
      </div>
    </>
  );
}

export function WorkflowDiagram(p: {
  profileId?: string;
  revision?: string;
  unsaved: boolean;
  disabled: boolean;
  mismatch: (version: string | null) => void;
}) {
  const [diagram, setDiagram] = useState<WorkflowDiagramView>();
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const retryAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => retryAbort.current?.abort(), []);
  useEffect(() => {
    if (!p.profileId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setDiagram(undefined);
    const poll = async () => {
      try {
        const next = await api<WorkflowDiagramView>(
          `/api/profiles/${encodeURIComponent(p.profileId as string)}/diagram`,
          p.mismatch,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setDiagram(next);
          setError(undefined);
        }
      } catch (caught) {
        const message = await apiError(
          caught,
          'Could not load the workflow diagram.',
        );
        if (!controller.signal.aborted) setError(message);
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [p.profileId, p.revision, p.mismatch, refresh]);

  const retry = async () => {
    const controller = new AbortController();
    retryAbort.current = controller;
    setRetrying(true);
    try {
      const next = await api<WorkflowDiagramView>(
        `/api/profiles/${encodeURIComponent(p.profileId as string)}/diagram/retry`,
        p.mismatch,
        { method: 'POST', signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setDiagram(next);
        setError(undefined);
        setRefresh((value) => value + 1);
      }
    } catch (caught) {
      const message = await apiError(
        caught,
        'Could not regenerate the diagram.',
      );
      if (!controller.signal.aborted) setError(message);
    } finally {
      if (!controller.signal.aborted) setRetrying(false);
    }
  };
  // Direction is presentation: existing cached summaries can be reused immediately.
  const ready =
    diagram?.status === 'ready' &&
    diagram.mermaid?.replace(/^flowchart (?:TB|TD|LR)\b/, 'flowchart LR');
  return (
    <section className={styles.workflowDiagram} aria-label="Workflow overview">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>At a glance</p>
          <h2>Workflow overview</h2>
          <p>
            Generated by your agent. Updates automatically when the saved
            workflow changes.
          </p>
        </div>
        <div className={styles.diagramActions}>
          {ready && (
            <button type="button" onClick={() => setExpanded(true)}>
              Expand
            </button>
          )}
          {(ready || diagram?.status === 'failed') && (
            <button
              type="button"
              disabled={p.disabled || retrying}
              onClick={() => void retry()}
            >
              {retrying ? 'Retrying…' : ready ? 'Regenerate' : 'Retry diagram'}
            </button>
          )}
        </div>
      </div>
      {!p.profileId ? (
        <p className={styles.diagramPlaceholder}>
          Save this profile to generate its workflow diagram.
        </p>
      ) : (
        <>
          {p.unsaved && (
            <p className={styles.diagramNotice}>
              Showing the saved workflow. Save your changes to update the
              diagram.
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {diagram?.status === 'failed' && (
            <p role="alert" className={styles.diagramPlaceholder}>
              {diagram.error}
            </p>
          )}
          {(!diagram ||
            diagram.status === 'queued' ||
            diagram.status === 'generating') &&
            !error && (
              <p role="status" className={styles.diagramPlaceholder}>
                {diagram?.status === 'generating'
                  ? 'Your agent is mapping the workflow…'
                  : 'Preparing your workflow diagram…'}
                <span>You can keep working while this runs.</span>
              </p>
            )}
          {ready && (
            <>
              <Chart key={diagram.sourceHash} source={ready} />
              <details className={styles.diagramSource}>
                <summary>Mermaid source</summary>
                <pre>{ready}</pre>
              </details>
              {expanded && (
                <Dialog
                  title="Workflow overview"
                  onClose={() => setExpanded(false)}
                >
                  <Chart source={ready} />
                </Dialog>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
