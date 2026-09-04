/**
 * Where Linear sends the developer back after they authorize (NG-600).
 *
 * This lives on the daemon rather than in a throwaway listener the wizard
 * spins up, because a redirect URI is as fixed at OAuth-app creation as the
 * webhook URL is: whatever is baked into the manifest is where Linear will send
 * every future authorization too, including the re-auth that follows a refresh
 * token finally being refused. A route that only exists during `rocky setup`
 * would be a dead address the second time it is needed.
 *
 * It is not on the public endpoint — this is the loopback bind. The tunnel
 * fronts the webhook, never anything that controls Runs (NG-576 §4).
 */

export class OAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCallbackError';
  }
}

export interface OAuthCallbackBroker {
  /**
   * Wait for the authorization code for one `state`. The state is checked on
   * arrival, so a callback Rocky did not ask for is refused rather than
   * exchanged.
   */
  expect(state: string): Promise<string>;
  /** Called by the route. Returns false when nothing was waiting. */
  deliver(result: { state?: string; code?: string; error?: string }): boolean;
  /** Give up on a pending wait — a wizard the human cancelled. */
  cancel(state: string, reason?: string): void;
}

interface Pending {
  resolve(code: string): void;
  reject(error: Error): void;
}

export function createOAuthCallbackBroker(): OAuthCallbackBroker {
  const pending = new Map<string, Pending>();

  return {
    expect(state) {
      return new Promise<string>((resolve, reject) => {
        pending.set(state, { resolve, reject });
      });
    },

    deliver({ state, code, error }) {
      if (!state) {
        return false;
      }
      const waiting = pending.get(state);
      if (!waiting) {
        // Either a stale tab or somebody poking the port. Neither is an error
        // worth taking the daemon down over; the route answers plainly.
        return false;
      }
      pending.delete(state);

      if (error) {
        waiting.reject(
          new OAuthCallbackError(`Linear refused the authorization: ${error}`),
        );
        return true;
      }
      if (!code) {
        waiting.reject(
          new OAuthCallbackError(
            'Linear came back without an authorization code.',
          ),
        );
        return true;
      }

      waiting.resolve(code);
      return true;
    },

    cancel(state, reason = 'the authorization was cancelled') {
      const waiting = pending.get(state);
      if (waiting) {
        pending.delete(state);
        waiting.reject(new OAuthCallbackError(reason));
      }
    },
  };
}

/** What the developer's browser is left looking at. */
export function callbackPage(body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Rocky</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; line-height: 1.5">
<h1>Rocky</h1>
<p>${body}</p>
</body>
</html>`;
}
