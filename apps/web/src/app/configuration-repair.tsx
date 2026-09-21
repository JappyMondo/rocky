import { useId, useRef, useState } from 'react';
import type { FlowConfigurationRepair } from '@rocky/local-contracts';
import { apiError } from './api.js';

export function ConfigurationRepair({
  disabled,
  submit,
}: {
  disabled: boolean;
  submit(requestId: string, repair: FlowConfigurationRepair): Promise<void>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState('');
  const [url, setUrl] = useState('');
  const [install, setInstall] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string | undefined>(undefined);
  return (
    <section>
      <button
        disabled={disabled || pending}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Repair configuration and resume
      </button>
      {open && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (disabled || pending) return;
            setPending(true);
            setError('');
            request.current ??= crypto.randomUUID();
            try {
              await submit(request.current, {
                ui: { start: start.trim(), url: url.trim() },
                ...(install.trim()
                  ? { commands: { install: install.trim() } }
                  : {}),
              });
            } catch (cause) {
              setError(
                await apiError(cause, 'Configuration could not be applied.'),
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <p>
            Resume UI validation with corrected settings. Completed
            implementation and reviews are preserved. These settings apply to
            this Run; update the profile separately for future Runs.
          </p>
          <label htmlFor={`${id}-start`}>
            UI start command (from the lead repository)
          </label>
          <textarea
            id={`${id}-start`}
            required
            disabled={pending}
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              request.current = undefined;
            }}
          />
          <label htmlFor={`${id}-url`}>UI URL (Rocky assigns the port)</label>
          <input
            id={`${id}-url`}
            type="url"
            required
            disabled={pending}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              request.current = undefined;
            }}
          />
          <label htmlFor={`${id}-install`}>
            Replacement install command (optional)
          </label>
          <textarea
            id={`${id}-install`}
            disabled={pending}
            value={install}
            onChange={(e) => {
              setInstall(e.target.value);
              request.current = undefined;
            }}
          />
          <button
            disabled={disabled || pending || !start.trim() || !url.trim()}
          >
            {pending ? 'Resuming…' : 'Apply and resume this Run'}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
}
