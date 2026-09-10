import { useEffect, useRef, type ReactNode } from 'react';
import styles from './app.module.css';

const paths = {
  runs: 'M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01',
  repo: 'M6 3h13v18H6a3 3 0 0 1 0-6h13M6 3a3 3 0 0 0-3 3v12M7 7h7',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'M19 12H5m5-5-5 5 5 5',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  branch:
    'M6 3v12a3 3 0 1 0 0 6 3 3 0 0 0 0-6m0-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 8c0-5 12-1 12-8m0 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  external:
    'M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  pause: 'M9 7v10M15 7v10M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
} as const;

export function Icon({
  name,
  size = 18,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Mark() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="12" fill="currentColor" />
      <path d="m9 16 1-7 8 5h4l8-5 1 7 2 7-7 8H14l-7-8 2-7Z" fill="#F3F5ED" />
      <path d="m8 21 7-4 5 4 5-4 7 4-6 6-6-3-6 3-6-6Z" fill="currentColor" />
      <circle cx="14" cy="22" r="1.5" fill="#F3F5ED" />
      <circle cx="26" cy="22" r="1.5" fill="#F3F5ED" />
      <path d="m17 28 3 3 3-3h-6Z" fill="currentColor" />
    </svg>
  );
}

const labels: Record<string, string> = {
  parked: 'Needs review',
  running: 'Running',
  queued: 'Queued',
  finished: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  done: 'Completed',
  waiting: 'Waiting',
};
export function Status({ value }: { value: string }) {
  return (
    <span className={styles.status} data-status={value}>
      <span className={`${styles.dot} ${styles[value]}`} />
      {labels[value] ?? value}
    </span>
  );
}

export function dateLabel(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const elements = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
        ) ?? [],
      ).filter((el) => !el.closest('details:not([open])'));
    (
      ref.current?.querySelector<HTMLInputElement>('input:not(:disabled)') ??
      ref.current
    )?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key === 'Tab') {
        const items = elements();
        const first = items[0];
        const last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className={styles.overlay}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={styles.dialog}
      >
        <header>
          <div>
            <p className={styles.eyebrow}>Rocky workspace</p>
            <h2>{title}</h2>
          </div>
          <button
            className={styles.iconButton}
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
