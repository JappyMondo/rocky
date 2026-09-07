import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { claudeCode, parseClaudeStream } from './claude-code.js';

describe('claudeCode.allowedTools', () => {
  it('maps every capability to Claude Code tools in capability order', () => {
    expect(claudeCode.allowedTools(['read', 'edit', 'bash'])).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash',
    ]);
  });
});

describe('Claude stream contract (synthetic, live capture still required)', () => {
  it('emits a boundary immediately after each tool result and returns native final usage', () => {
    const stream = readFileSync(
      new URL('./fixtures/claude-synthetic.jsonl', import.meta.url),
      'utf8',
    );
    expect(parseClaudeStream(stream.split('\n'))).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      text: '<result>pong</result>',
      events: [
        { kind: 'tool-call', name: 'Bash' },
        { kind: 'tool-result', name: 'Bash' },
        { kind: 'turn-boundary' },
        { kind: 'text', text: '<result>pong</result>' },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        usd: 0.001,
      },
    });
  });

  it.each([
    [null, /Invalid/],
    [{ type: 'unknown' }, /Unknown/],
    [{ type: 'assistant', message: { content: 'text' } }, /content/],
    [
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] },
      },
      /matching call/,
    ],
    [{ type: 'result', subtype: 'success' }, /final text/],
    [
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['model not found'],
      },
      /model not found/,
    ],
    [{ type: 'result', subtype: 'success', result: 'ok', usage: [] }, /usage/],
    [
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: { input_tokens: -1 },
      },
      /usage/,
    ],
  ])('rejects malformed or failed native record %j', (record, error) => {
    expect(() => parseClaudeStream([JSON.stringify(record)])).toThrow(error);
  });

  it('ignores subagent output and optional stream metadata without borrowing their session', () => {
    const records = [
      { type: 'assistant', parent_tool_use_id: 'outer', session_id: 'another' },
      { type: 'system', session_id: 'own' },
      { type: 'rate_limit_event' },
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking' }, { type: 'tool_use' }] },
      },
      { type: 'result', subtype: 'success', result: 'own result' },
    ];
    expect(
      parseClaudeStream(records.map((record) => JSON.stringify(record))),
    ).toEqual({ sessionId: 'own', text: 'own result', events: [] });
  });

  it('requires a final result and a single session identity', () => {
    expect(() => parseClaudeStream([])).toThrow(/final result/);
    expect(() =>
      parseClaudeStream([
        '{"type":"system","session_id":"one"}',
        '{"type":"system","session_id":"two"}',
      ]),
    ).toThrow(/changed session/);
    expect(() =>
      parseClaudeStream([
        '{"type":"result","subtype":"success","result":"ok"}',
      ]),
    ).toThrow(/session ID/);
  });
});
