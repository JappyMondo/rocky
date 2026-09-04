import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseOpencodeStream } from './opencode.js';

const toolCallFixture = readFileSync(
  new URL('./fixtures/opencode-1.17.7-tool-call.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n');

describe('parseOpencodeStream', () => {
  it('parses the OpenCode 1.17.7 tool-call stream', () => {
    expect(parseOpencodeStream(toolCallFixture)).toEqual({
      sessionId: 'ses_opencode_1_17_7',
      text: 'pong',
      events: [
        { kind: 'tool-call', name: 'bash' },
        { kind: 'tool-result', name: 'bash' },
        { kind: 'turn-boundary' },
        { kind: 'text', text: 'pong' },
      ],
      usage: {
        inputTokens: 200,
        outputTokens: 60,
        cacheReadTokens: 35,
        cacheCreationTokens: 12,
        usd: 0.0042,
      },
    });
  });

  it('rejects invalid JSON', () => {
    expect(() => parseOpencodeStream(['not json'])).toThrow(
      'Invalid OpenCode JSONL',
    );
  });

  it('rejects unknown events', () => {
    expect(() =>
      parseOpencodeStream(['{"type":"unknown","sessionID":"ses_1"}']),
    ).toThrow('Unknown OpenCode stream event');
  });

  it('rejects streams without a session ID', () => {
    expect(() =>
      parseOpencodeStream(['{"type":"step_start"}']),
    ).toThrow('OpenCode stream did not include a session ID');
  });
});
