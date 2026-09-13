import { useRef, useState } from 'react';
import { apiError } from './api.js';
import styles from './app.module.css';
export function RetryStep({
  disabled,
  submit,
}: {
  disabled: boolean;
  submit(requestId: string): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef<string | undefined>(undefined);
  return (
    <div className={styles.retryStep}>
      <button
        type="button"
        disabled={disabled || pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setError('');
          requestId.current ??= crypto.randomUUID();
          try {
            await submit(requestId.current);
          } catch (error) {
            setError(await apiError(error, 'Step could not be retried.'));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Queuing retry…' : 'Retry failed step'}
      </button>
      <small>
        Retries failed work and continues this Run. Earlier results and
        completed parallel branches are reused.
      </small>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
