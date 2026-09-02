/**
 * The redaction set (NG-578): every value in `credentials.json`, plus any
 * config value whose key matches /(token|secret|key|password)/i, kept out of
 * daemon logs and journals.
 *
 * Two different rules because the two files are different: `credentials.json`
 * is secret in its entirety, so key names there mean nothing, while
 * `config.json` is mostly the readable material a log needs — repo names,
 * URLs, labels — and redacting it wholesale would leave nothing to read.
 */
import { Writable } from 'node:stream';

export const REDACTED = '[redacted]';

/** What makes a `config.json` key's value secret. */
export const SECRET_KEY_PATTERN = /(token|secret|key|password)/i;

export type Redactor = (text: string) => string;

function collectAllStrings(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value !== '') {
      into.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAllStrings(item, into);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectAllStrings(item, into);
    }
  }
}

function collectSecretKeyed(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretKeyed(item, into);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      // A secret-looking key taints everything beneath it, not just a string
      // sitting directly under it.
      collectAllStrings(child, into);
    } else {
      collectSecretKeyed(child, into);
    }
  }
}

/**
 * Every string that must not reach a log. Built from the parsed files, so a
 * reload rebuilds it and a newly added token is covered from that moment.
 */
export function buildRedactionSet(
  config: unknown,
  credentials: unknown,
): string[] {
  const secrets = new Set<string>();
  collectAllStrings(credentials, secrets);
  collectSecretKeyed(config, secrets);
  return [...secrets];
}

/**
 * Longest first: a short secret that is a prefix of a longer one would
 * otherwise be replaced inside it and leave the longer one's tail in the log.
 * `replaceAll` with a string needle is literal, so a secret full of regex
 * metacharacters needs no escaping.
 */
export function createRedactor(secrets: Iterable<string>): Redactor {
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length);

  if (ordered.length === 0) {
    return (text) => text;
  }

  return (text) => {
    let redacted = text;
    for (const secret of ordered) {
      redacted = redacted.replaceAll(secret, REDACTED);
    }
    return redacted;
  };
}

/**
 * Wraps a log destination so everything written passes the redactor first.
 *
 * Buffered to the newline rather than redacting each chunk: a secret that
 * straddles a chunk boundary is exactly the one that would otherwise reach
 * disk intact.
 */
export function redactingStream(
  destination: Writable,
  redact: Redactor,
): Writable {
  let pending = '';

  const flush = (
    upTo: number,
    callback: (error?: Error | null) => void,
  ): void => {
    const complete = pending.slice(0, upTo);
    pending = pending.slice(upTo);

    if (complete === '') {
      callback();
      return;
    }
    destination.write(redact(complete), callback);
  };

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      pending += chunk.toString();
      flush(pending.lastIndexOf('\n') + 1, callback);
    },
    final(callback) {
      // Whatever is left has no newline on it; it still has to be redacted.
      flush(pending.length, (error) => {
        if (error) {
          callback(error);
          return;
        }
        // The wrapper owns the destination, so closing the wrapper closes it —
        // otherwise a caller has to end both in the right order, and ending
        // the destination first loses whatever is still queued in here.
        destination.end(callback);
      });
    },
  });

  // The wrapper owns the destination it was handed, so it owns its errors too.
  // An unhandled 'error' on a log file would take the daemon down with it.
  destination.on('error', (error: Error) => {
    if (!stream.destroyed) {
      stream.destroy(error);
    }
  });

  return stream;
}
