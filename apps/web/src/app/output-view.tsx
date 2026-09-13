import { isValidElement, memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Chart } from './workflow-diagram.js';
import { cleanOutput, outputValue } from './transcript.js';
import styles from './output-view.module.css';

function Diagram({ source }: { source: string }) {
  const [draw, setDraw] = useState(false);
  return (
    <div className={styles.diagram}>
      <button type="button" onClick={() => setDraw(!draw)}>
        {draw ? 'Show diagram source' : 'Render diagram'}
      </button>
      {draw ? (
        <Chart source={source} />
      ) : (
        <pre>
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className={styles.prose}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Output cannot execute HTML or silently load remote images.
          img: ({ alt }) => (
            <span className={styles.imageLabel}>
              Image: {alt || 'attached image'}
            </span>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => {
            if (
              isValidElement<{ className?: string; children?: unknown }>(
                children,
              ) &&
              children.props.className === 'language-mermaid'
            )
              return (
                <Diagram source={String(children.props.children).trim()} />
              );
            return <pre>{children}</pre>;
          },
        }}
      >
        {cleanOutput(text)}
      </Markdown>
    </div>
  );
});
export function CodeOutput({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const cleaned = cleanOutput(text);
  return (
    <div className={styles.codeOutput}>
      <pre>{all ? cleaned : cleaned.slice(0, 12_000)}</pre>
      {cleaned.length > 12_000 && (
        <button type="button" onClick={() => setAll(!all)}>
          {all
            ? 'Show less'
            : `Show all ${cleaned.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}
const label = (key: string) =>
  key === 'ci'
    ? 'CI'
    : key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .replace(/^./, (char) => char.toUpperCase());

/** Render arbitrary schema results without requiring workflow-specific UI code. */
export function OutputValue({
  value,
  code = false,
  depth = 0,
}: {
  value: unknown;
  code?: boolean;
  depth?: number;
}) {
  const [all, setAll] = useState(false);
  const parsed = outputValue(value);
  if (typeof parsed === 'string')
    return code || parsed.length > 30_000 ? (
      <CodeOutput text={parsed} />
    ) : (
      <Prose text={parsed} />
    );
  if (parsed === undefined) return null;
  if (parsed === null || typeof parsed !== 'object')
    return <span className={styles.scalar}>{String(parsed)}</span>;
  if (depth >= 5) return <CodeOutput text={JSON.stringify(parsed, null, 2)} />;
  if (Array.isArray(parsed))
    return parsed.length ? (
      <div className={styles.collection}>
        <ol>
          {(all ? parsed : parsed.slice(0, 20)).map((item, i) => (
            <li key={i}>
              <OutputValue value={item} code={code} depth={depth + 1} />
            </li>
          ))}
        </ol>
        {parsed.length > 20 && (
          <button type="button" onClick={() => setAll(!all)}>
            {all ? 'Show fewer items' : `Show all ${parsed.length} items`}
          </button>
        )}
      </div>
    ) : (
      <span className={styles.empty}>None</span>
    );
  const entries = Object.entries(parsed).sort(([a], [b]) =>
    a === 'summary' ? -1 : b === 'summary' ? 1 : 0,
  );
  if (!entries.length) return <span className={styles.empty}>No fields</span>;
  return (
    <dl className={styles.fields}>
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{label(key)}</dt>
          <dd>
            <OutputValue
              value={item}
              code={
                code ||
                [
                  'stdout',
                  'stderr',
                  'command',
                  'patch',
                  'patchText',
                  'diff',
                  'old_string',
                  'new_string',
                ].includes(key)
              }
              depth={depth + 1}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
