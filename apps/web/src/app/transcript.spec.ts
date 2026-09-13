import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanOutput, outputValue, TranscriptDecoder } from './transcript.js';
const lines = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const parse = (...events: unknown[]) =>
  new TranscriptDecoder().push(lines(...events));
const stream = (event: unknown) => ({
  type: 'stream_event',
  session_id: 'session',
  event,
});

describe('Transcript decoding', () => {
  it.each([
    'opencode-1.18.29-live.jsonl',
    'opencode-1.17.7-tool-call.jsonl',
    'claude-synthetic.jsonl',
  ])('replays %s identically across arbitrary chunk boundaries', (file) => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        `../../../../packages/daemon/src/harness/fixtures/${file}`,
      ),
      'utf8',
    );
    const complete = new TranscriptDecoder();
    complete.push(source);
    const expected = complete.finish();
    expect(
      expected.items.some(
        (item) => item.kind === 'tool' && item.status === 'completed',
      ),
    ).toBe(true);
    expect(expected.items.some((item) => item.kind === 'message')).toBe(true);
    for (const size of [1, 17, 4096]) {
      const chunked = new TranscriptDecoder();
      for (let index = 0; index < source.length; index += size)
        chunked.push(source.slice(index, index + size));
      expect(chunked.finish()).toEqual(expected);
    }
  });
  it('does not expose fragmented JSON, including a final record without newline', () => {
    const decoder = new TranscriptDecoder();
    expect(decoder.push('{"type":"text",').items).toEqual([]);
    expect(decoder.push('"part":{"text":"你好 🦝"}}').pending).toBe(true);
    expect(decoder.finish().items[0].text).toBe('你好 🦝');
  });
  it('updates OpenCode tools by call ID, keeping status and duration with their inputs and output', () => {
    const tool = (state: unknown, callID: string | undefined = 'one') => ({
      type: 'tool_use',
      sessionID: 'session',
      part: { tool: 'bash', callID, state },
    });
    const decoder = new TranscriptDecoder();
    decoder.push(
      lines(tool({ status: 'running', input: { command: 'pnpm test' } })),
    );
    const old = decoder.snapshot();
    const result = decoder.push(
      lines(
        tool({
          status: 'completed',
          title: 'Run tests',
          input: { command: 'pnpm test' },
          output: 'passed',
          time: { start: 100, end: 200 },
        }),
      ),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: 'bash',
      status: 'completed',
      output: 'passed',
      ms: 100,
    });
    expect(old.items[0].status).toBe('running');
    expect(
      parse(tool({ status: 'error', error: 'exit 1' })).items[0],
    ).toMatchObject({ status: 'error', output: 'exit 1' });
    expect(
      parse({ type: 'reasoning', part: { id: 'r', text: 'Checking' } }).items[0]
        .kind,
    ).toBe('reasoning');
  });
  it('pairs interleaved Claude tools, partial inputs and final snapshots without duplicate messages', () => {
    const result = parse(
      stream({ type: 'message_start', message: { id: 'msg' } }),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world' },
      }),
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
      }),
      stream({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":' },
      }),
      stream({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"pwd"}' },
      }),
      stream({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'thinking', thinking: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'thinking_delta', thinking: 'Inspect first' },
      }),
      stream({ type: 'content_block_stop', index: 2 }),
      stream({ type: 'message_stop' }),
      {
        type: 'assistant',
        session_id: 'session',
        message: {
          id: 'msg',
          content: [
            { type: 'text', text: 'Hello world' },
            {
              type: 'tool_use',
              id: 'a',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            { type: 'thinking', thinking: 'Inspect first' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'b',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b',
              content: [
                { type: 'text', text: 'A' },
                { type: 'text', text: 'B' },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'a',
              content: 'Denied',
              is_error: true,
            },
          ],
        },
      },
      {
        type: 'result',
        result: 'Hello world',
        usage: { input_tokens: 20 },
        total_cost_usd: 0,
      },
    );
    expect(result.items.filter((item) => item.kind === 'message')).toHaveLength(
      1,
    );
    expect(result.items.find((item) => item.title === 'Bash')).toMatchObject({
      input: { command: 'pwd' },
      output: 'Denied',
      status: 'error',
    });
    expect(result.items.find((item) => item.title === 'Read')?.output).toBe(
      'A\nB',
    );
    expect(result.items.find((item) => item.kind === 'reasoning')?.text).toBe(
      'Inspect first',
    );
  });
  it('keeps unknown events, nested errors and non-text tool results inspectable', () => {
    const result = parse(
      { type: 'new_event', nested: [1, { a: true }] },
      { type: 'error', error: { message: 'Denied' } },
      { type: 'result', is_error: true, result: 'Failed', errors: ['timeout'] },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'orphan',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', data: 'safe-fixture' },
                },
              ],
            },
          ],
        },
      },
      { type: 'user', message: { content: 'Continue' } },
      { type: 'assistant', message: {} },
      {
        type: 'assistant',
        message: { content: [{ type: 'image', source: 'fixture' }] },
      },
      stream({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '?' },
      }),
      stream({ type: 'new_stream_event' }),
      null,
      [1, 2],
      { type: 'system', subtype: 'init' },
    );
    expect(
      result.items.find((item) => item.title === 'new_event')?.data,
    ).toEqual({ type: 'new_event', nested: [1, { a: true }] });
    expect(result.items.filter((item) => item.kind === 'error')).toHaveLength(
      3,
    );
    expect(
      result.items.find((item) => item.title === 'Tool result')?.output,
    ).toEqual([
      { type: 'image', source: { type: 'base64', data: 'safe-fixture' } },
    ]);
    expect(result.items.find((item) => item.title === 'You')?.text).toBe(
      'Continue',
    );
  });
  it('recovers after malformed records and streams plain diagnostic output', () => {
    const decoder = new TranscriptDecoder();
    expect(decoder.push('plain output').items[0].text).toBe('plain output');
    const result = decoder.push(
      '\nsecond line\r\n\n{broken}\n' +
        lines({ type: 'text', part: { text: 'Recovered' } }),
    );
    expect(result.items[0].text).toBe('plain output\nsecond line\n{broken}');
    expect(result.items[1].text).toBe('Recovered');
    expect(new TranscriptDecoder().push('{broken}\n').items[0].title).toBe(
      'Unparsed record',
    );
  });
  it('bounds raw history and entry count without chopping parsed records', () => {
    const decoder = new TranscriptDecoder();
    for (let index = 0; index < 1010; index++)
      decoder.push(
        lines({
          type: 'text',
          part: { id: String(index), text: 'x'.repeat(300) },
        }),
      );
    const result = decoder.finish();
    expect(result.items).toHaveLength(1000);
    expect(result.omitted).toBe(10);
    expect(result.items[0].text).toHaveLength(300);
    expect(result.raw.length).toBe(200_000);
    expect(result.rawTruncated).toBe(true);
  });
  it('recovers after oversized complete and fragmented records', () => {
    const decoder = new TranscriptDecoder();
    decoder.push('{"payload":"' + 'x'.repeat(2_000_001));
    const result = decoder.push(
      'tail"}\n' + lines({ type: 'text', part: { text: 'Still working' } }),
    );
    expect(result.items.map((item) => item.title)).toEqual([
      'Record too large',
      'Agent',
    ]);
    expect(
      new TranscriptDecoder().push('x'.repeat(2_000_001) + '\n').items[0].title,
    ).toBe('Record too large');
  });
  it('decodes structured result envelopes and strips terminal controls', () => {
    expect(outputValue('<result>{"summary":"Done"}</result>')).toEqual({
      summary: 'Done',
    });
    expect(outputValue('```json\n[1,2]\n```')).toEqual([1, 2]);
    expect(outputValue('<result>plain</result>')).toBe('plain');
    expect(outputValue('{partial')).toBe('{partial');
    expect(outputValue('prose')).toBe('prose');
    expect(outputValue(false)).toBe(false);
    expect(cleanOutput('\x1b[31mred\x1b[0m\x00\x1b]0;title\x07')).toBe('red');
  });
});
