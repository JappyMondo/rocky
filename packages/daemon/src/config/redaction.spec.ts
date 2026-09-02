/**
 * AC5: a secret value planted in config or credentials never appears in daemon
 * logs.
 *
 * The redaction set is every value in `credentials.json`, plus any config
 * value whose key matches /(token|secret|key|password)/i (NG-578).
 */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  buildRedactionSet,
  createRedactor,
  redactingStream,
} from './redaction.js';

describe('the redaction set', () => {
  it('takes every value in credentials.json, at any depth and under any key', () => {
    const secrets = buildRedactionSet(
      {},
      {
        linear: { accessToken: 'lin_aaa', clientId: 'client_bbb' },
        repos: { niotix: { NPM_TOKEN: 'npm_ccc', PLAIN_LOOKING: 'ddd' } },
        mcp: { 'https://mcp.linear.app/sse': { refreshToken: 'eee' } },
      },
    );

    // Nothing in credentials.json is innocent — the key names mean nothing
    // there, so a value under `PLAIN_LOOKING` is redacted like the rest.
    expect(secrets).toEqual(
      expect.arrayContaining([
        'lin_aaa',
        'client_bbb',
        'npm_ccc',
        'ddd',
        'eee',
      ]),
    );
  });

  it('takes config values whose key looks secret, and leaves the rest legible', () => {
    const secrets = buildRedactionSet(
      {
        publicUrl: 'https://rocky.example.com',
        repos: [
          {
            name: 'niotix',
            label: 'rocky',
            env: { API_TOKEN: 'tok_xxx', LOG_LEVEL: 'debug' },
          },
        ],
      },
      {},
    );

    expect(secrets).toContain('tok_xxx');
    // A log that redacted repo names and URLs would be unreadable.
    expect(secrets).not.toContain('https://rocky.example.com');
    expect(secrets).not.toContain('niotix');
    expect(secrets).not.toContain('debug');
  });

  it.each(['API_TOKEN', 'clientSecret', 'sshKey', 'PASSWORD', 'access_token'])(
    'treats %s as a secret key',
    (key) => {
      expect(buildRedactionSet({ [key]: 'planted' }, {})).toContain('planted');
    },
  );

  it('treats everything under a secret-looking key as secret, however nested', () => {
    const secrets = buildRedactionSet(
      { secrets: { deep: { deeper: ['planted'] } } },
      {},
    );

    expect(secrets).toContain('planted');
  });

  it('skips empty strings, which would otherwise match everywhere', () => {
    expect(
      buildRedactionSet({ token: '' }, { linear: { accessToken: '' } }),
    ).toEqual([]);
  });

  it('ignores non-strings rather than stringifying them into the set', () => {
    expect(buildRedactionSet({ port: 7625, token: null }, {})).toEqual([]);
  });
});

describe('the redactor', () => {
  it('replaces a secret wherever it appears in a line', () => {
    const redact = createRedactor(['sk-live-123']);

    expect(redact('used sk-live-123 twice: sk-live-123')).toBe(
      `used ${REDACTED} twice: ${REDACTED}`,
    );
  });

  it('redacts the longest secret first, so no tail survives', () => {
    // 'abc' is a prefix of 'abcdef'. Replacing the short one first would leave
    // '[redacted]def' in the log — the longer secret, partly intact.
    const redact = createRedactor(['abc', 'abcdef']);

    expect(redact('abcdef')).toBe(REDACTED);
  });

  it('treats a secret containing regex metacharacters literally', () => {
    const redact = createRedactor(['a.*b$']);

    expect(redact('x a.*b$ y')).toBe(`x ${REDACTED} y`);
    expect(redact('x aXXbZ y')).toBe('x aXXbZ y');
  });

  it('is a no-op with nothing to redact', () => {
    expect(createRedactor([])('anything at all')).toBe('anything at all');
  });
});

describe('the redacting stream', () => {
  async function through(
    redact: (text: string) => string,
    writes: string[],
  ): Promise<string> {
    const sink = new PassThrough();
    let captured = '';
    sink.on('data', (chunk: Buffer) => {
      captured += chunk.toString();
    });

    const stream = redactingStream(sink, redact);
    for (const write of writes) {
      stream.write(write);
    }
    await new Promise<void>((resolve) => stream.end(resolve));

    return captured;
  }

  it('redacts what passes through it', async () => {
    const redact = createRedactor(['sk-live-123']);

    expect(await through(redact, ['level=info token=sk-live-123\n'])).toBe(
      `level=info token=${REDACTED}\n`,
    );
  });

  it('redacts a secret split across two writes', async () => {
    // Buffering to the newline is what makes this hold: a secret straddling a
    // chunk boundary is the one that would otherwise slip through whole.
    const redact = createRedactor(['sk-live-123']);

    expect(await through(redact, ['a sk-live', '-123 b\n'])).toBe(
      `a ${REDACTED} b\n`,
    );
  });

  it('flushes a trailing line with no newline on it', async () => {
    const redact = createRedactor(['sk-live-123']);

    expect(await through(redact, ['tail sk-live-123'])).toBe(
      `tail ${REDACTED}`,
    );
  });

  it('passes many lines through in order', async () => {
    const redact = createRedactor(['s3cret']);

    expect(await through(redact, ['one s3cret\ntwo\n', 'three s3cret\n'])).toBe(
      `one ${REDACTED}\ntwo\nthree ${REDACTED}\n`,
    );
  });

  it('surfaces a destination error rather than swallowing it', async () => {
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });
    const stream = redactingStream(broken, (text) => text);

    const failed = new Promise<Error>((resolve) => stream.on('error', resolve));
    stream.write('a line\n');

    expect((await failed).message).toBe('disk full');
  });
});
