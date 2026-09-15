import { useId, useRef, useState } from 'react';
import { apiError } from './api.js';
import styles from './app.module.css';
export function RetryStep({
  disabled,
  submit,
  continueRounds,
}: {
  disabled: boolean;
  continueRounds?: number;
  submit(requestId: string, recoveryInstructions?: string): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [solve, setSolve] = useState(false);
  const [instructions, setInstructions] = useState('');
  const id = useId();
  const requestId = useRef<string | undefined>(undefined);
  const recoveryId = useRef<string | undefined>(undefined);
  const retry = async (withAgent: boolean) => {
    if (disabled || pending || (withAgent && !instructions.trim())) return;
    setPending(true);
    setError('');
    const receipt = withAgent ? recoveryId : requestId;
    receipt.current ??= crypto.randomUUID();
    try {
      await submit(
        receipt.current,
        withAgent ? instructions.trim() : undefined,
      );
    } catch (error) {
      setError(
        await apiError(
          error,
          continueRounds
            ? 'Review could not be continued.'
            : 'Step could not be retried.',
        ),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={styles.retryStep}>
      <div>
        <button
          type="button"
          disabled={disabled || pending}
          onClick={() => void retry(false)}
        >
          {pending
            ? continueRounds
              ? 'Queuing continuation…'
              : 'Queuing retry…'
            : continueRounds
              ? `Continue for another ${continueRounds} rounds`
              : 'Retry failed step'}
        </button>{' '}
        {!continueRounds && (
          <button
            type="button"
            disabled={disabled || pending}
            aria-expanded={solve}
            aria-controls={id}
            onClick={() => setSolve(!solve)}
          >
            Solve with agent
          </button>
        )}
      </div>
      <small>
        {continueRounds
          ? `Resets the review counter to 0 and allows ${continueRounds} more rounds. Existing work and feedback are preserved.`
          : 'Retries failed work and continues this Run. Earlier results and completed parallel branches are reused.'}
      </small>
      {solve && (
        <form
          id={id}
          className={styles.checkpointCompose}
          onSubmit={(event) => {
            event.preventDefault();
            void retry(true);
          }}
        >
          <label htmlFor={`${id}-instructions`}>
            Instructions for the error handling agent
          </label>
          <textarea
            id={`${id}-instructions`}
            value={instructions}
            maxLength={12000}
            disabled={disabled || pending}
            placeholder="What should the agent investigate or fix? Include any settings you changed."
            onChange={(event) => {
              setInstructions(event.target.value);
              recoveryId.current = undefined;
            }}
          />
          <small>
            The agent receives the error, recent step results, workspace
            details, and current Git identity settings. It can inspect and edit
            the workspace and run commands. Rocky retries the failed work when
            the agent finishes.
          </small>
          <button disabled={disabled || pending || !instructions.trim()}>
            Start agent and retry
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
