import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseOpencodeStream } from './opencode.js';

const toolCallFixture = readFileSync(
  new URL('./fixtures/opencode-1.17.7-tool-call.jsonl', import.meta.url),
  'utf8',
)
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

  it('aggregates native cost from every finished step', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.001}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0.0042}}',
    ]);

    expect(result.usage).toEqual({ usd: 0.0052 });
  });

  it('concatenates text parts in event order', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"text","part":{"type":"text","text":"ping"}}',
      '{"type":"text","part":{"type":"text","text":" pong"}}',
    ]);

    expect(result.text).toBe('ping pong');
    expect(result.events).toEqual([
      { kind: 'text', text: 'ping' },
      { kind: 'text', text: ' pong' },
    ]);
  });

  it('omits usage when finished steps contain no token or cost fields', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
    ]);

    expect(result.usage).toBeUndefined();
  });

  it('retains an empty usage object when tokens are supplied', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{}}}',
    ]);

    expect(result.usage).toEqual({});
  });

  it('accepts trailing blank records', () => {
    expect(
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
        '',
        '',
      ]),
    ).toMatchObject({ sessionId: 'ses_1' });
  });

  it('rejects blank records between JSON events', () => {
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
      ]),
    ).toThrow('Invalid OpenCode JSONL');
  });

  it('rejects malformed token values', () => {
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":-1}}}',
      ]),
    ).toThrow('Invalid OpenCode usage');
  });

  it('rejects non-finite native cost', () => {
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":1e999}}',
      ]),
    ).toThrow('Invalid OpenCode usage');
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
