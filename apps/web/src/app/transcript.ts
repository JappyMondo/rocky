/** Presentation-only decoding. The retained Transcript remains the source of truth. */
export interface Activity {
  id: string;
  kind: 'message' | 'reasoning' | 'tool' | 'event' | 'output' | 'error';
  title: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  status?: 'running' | 'completed' | 'error';
  time?: number;
  ms?: number;
  data?: unknown;
}
export interface Transcript {
  items: Activity[];
  raw: string;
  omitted: number;
  rawTruncated: boolean;
  pending: boolean;
}
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) =>
  typeof value === 'number' ? value : undefined;
const RAW_LIMIT = 200_000;
const RECORD_LIMIT = 2_000_000;
const ITEM_LIMIT = 1000;

export function cleanOutput(text: string): string {
  // Terminal control codes are presentation, never content or markup.
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  /* eslint-enable no-control-regex */
}
export function outputValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  const wrapped =
    /^<result>([\s\S]*)<\/result>$/.exec(text)?.[1] ??
    /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1];
  const candidate = wrapped ?? text;
  if (wrapped !== undefined || /^[[{]/.test(candidate)) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* Partial or non-JSON output. */
    }
  }
  return wrapped ?? value;
}

/** Incremental JSONL parser: chunk boundaries never become record boundaries. */
export class TranscriptDecoder {
  private items: Activity[] = [];
  private raw = '';
  private buffer = '';
  private skipping = false;
  private omitted = 0;
  private rawTruncated = false;
  private sequence = 0;
  private sizes = new Map<string, number>();
  private retainedSize = 0;
  private scope = '';
  private message = '';
  private blocks = new Map<number, { id: string; json: string }>();

  push(chunk: string): Transcript {
    this.rawTruncated ||= this.raw.length + chunk.length > RAW_LIMIT;
    this.raw = (this.raw + chunk).slice(-RAW_LIMIT);
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.skipping) this.line(line);
      this.skipping = false;
    }
    if (this.buffer.length > RECORD_LIMIT) {
      this.add({
        kind: 'error',
        title: 'Record too large',
        text: 'A record exceeded the 2 MB display limit. Parsing resumes at the next line.',
      });
      this.buffer = '';
      this.skipping = true;
    }
    return this.snapshot();
  }
  finish(): Transcript {
    if (this.buffer && !this.skipping) this.line(this.buffer);
    this.buffer = '';
    this.skipping = false;
    return this.snapshot();
  }
  snapshot(): Transcript {
    // Plain output can stream without a newline. Incomplete JSON stays buffered.
    const plain = this.buffer.trim() && !/^[[{]/.test(this.buffer.trim());
    return {
      items: plain
        ? [
            ...this.items,
            {
              id: 'pending',
              kind: 'output',
              title: 'Output',
              text: cleanOutput(this.buffer),
            },
          ]
        : [...this.items],
      raw: this.raw,
      omitted: this.omitted,
      rawTruncated: this.rawTruncated,
      pending: !!this.buffer && !plain,
    };
  }
  private add(item: Omit<Activity, 'id'> & { id?: string }) {
    const id = item.id ?? `record:${++this.sequence}`;
    const index = this.items.findIndex((entry) => entry.id === id);
    if (index >= 0) this.items[index] = { ...this.items[index], ...item, id };
    else this.items.push({ ...item, id });
    const saved = this.items[index >= 0 ? index : this.items.length - 1];
    const size = JSON.stringify(saved).length;
    this.retainedSize += size - (this.sizes.get(id) ?? 0);
    this.sizes.set(id, size);
    while (this.items.length > ITEM_LIMIT || this.retainedSize > 4_000_000) {
      const removed = this.items.shift();
      if (!removed) break;
      this.retainedSize -= this.sizes.get(removed.id) ?? 0;
      this.sizes.delete(removed.id);
      this.omitted++;
    }
  }
  private line(line: string) {
    if (!line.trim()) return;
    if (line.length > RECORD_LIMIT) {
      this.add({
        kind: 'error',
        title: 'Record too large',
        text: 'A record exceeded the 2 MB display limit.',
      });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const previous = this.items.at(-1);
      if (previous?.kind === 'output' && (previous.text?.length ?? 0) < 20_000)
        this.add({
          ...previous,
          text: `${previous.text}\n${cleanOutput(line)}`,
        });
      else
        this.add({
          kind: 'output',
          title: /^[[{]/.test(line.trim()) ? 'Unparsed record' : 'Output',
          text: cleanOutput(line),
        });
      return;
    }
    const event = object(value);
    const type = string(event.type);
    this.scope = string(event.sessionID ?? event.session_id) || this.scope;
    const part = object(event.part);
    const time = number(event.timestamp);
    const id = string(part.id);
    if (
      (type === 'text' || type === 'reasoning') &&
      typeof part.text === 'string'
    ) {
      this.add({
        id: id ? `${this.scope}:${id}` : undefined,
        kind: type === 'text' ? 'message' : 'reasoning',
        title: type === 'text' ? 'Agent' : 'Reasoning',
        text: part.text,
        time,
      });
    } else if (type === 'tool_use' && part.tool) {
      const state = object(part.state);
      const timing = object(state.time);
      this.add({
        id: `${this.scope}:tool:${string(part.callID) || id || ++this.sequence}`,
        kind: 'tool',
        title: string(part.tool),
        text: string(state.title),
        input: state.input,
        output: state.error ?? state.output,
        status:
          state.status === 'error'
            ? 'error'
            : state.status === 'completed'
              ? 'completed'
              : 'running',
        time,
        ms:
          typeof timing.end === 'number' && typeof timing.start === 'number'
            ? timing.end - timing.start
            : undefined,
      });
    } else if (type === 'assistant' || type === 'user') {
      const message = object(event.message);
      const messageId =
        string(message.id) || this.message || `message:${++this.sequence}`;
      if (Array.isArray(message.content))
        message.content.forEach((block, index) =>
          this.block(
            object(block),
            `${this.scope}:${messageId}:${index}`,
            type,
          ),
        );
      else if (typeof message.content === 'string')
        this.add({
          kind: 'message',
          title: type === 'user' ? 'You' : 'Agent',
          text: message.content,
        });
      else this.add({ kind: 'event', title: type, data: value });
    } else if (type === 'stream_event') {
      this.partial(object(event.event));
    } else if (type === 'result') {
      const failed = event.is_error === true;
      // Claude repeats the final assistant text in its result envelope.
      const text = string(event.result);
      if (
        text &&
        !this.items.some(
          (item) => item.kind === 'message' && item.text === text,
        )
      )
        this.add({
          kind: failed ? 'error' : 'message',
          title: failed ? 'Agent error' : 'Agent',
          text,
        });
      this.add({
        kind: failed ? 'error' : 'event',
        title: failed ? 'Agent failed' : 'Turn completed',
        output: event.errors,
        data: {
          ...object(event.usage),
          cost: event.total_cost_usd,
          durationMs: event.duration_ms,
        },
      });
    } else if (type === 'step_start') {
      this.add({ kind: 'event', title: 'Turn started', time });
    } else if (type === 'step_finish') {
      this.add({
        kind: 'event',
        title: 'Turn completed',
        time,
        data: { reason: part.reason, tokens: part.tokens, cost: part.cost },
      });
    } else if (type === 'error') {
      this.add({
        kind: 'error',
        title: 'Agent error',
        output: event.error ?? value,
        time,
      });
    } else if (type === 'system' && event.subtype === 'init') {
      this.add({
        kind: 'event',
        title: 'Session started',
        data: { model: event.model, session: event.session_id },
      });
    } else {
      this.add({
        kind: 'event',
        title: type || 'JSON record',
        data: value,
        time,
      });
    }
  }
  private block(block: RecordValue, id: string, role = 'assistant') {
    if (block.type === 'tool_use') {
      this.add({
        id: `${this.scope}:tool:${block.id}`,
        kind: 'tool',
        title: string(block.name) || 'Tool',
        input: block.input,
        status: 'running',
      });
    } else if (block.type === 'tool_result') {
      const key = `${this.scope}:tool:${block.tool_use_id}`;
      const existing = this.items.find((item) => item.id === key);
      const content = Array.isArray(block.content)
        ? block.content.map((part) =>
            object(part).type === 'text' ? object(part).text : part,
          )
        : block.content;
      this.add({
        id: key,
        kind: 'tool',
        title: existing?.title ?? 'Tool result',
        output:
          Array.isArray(content) &&
          content.every((part) => typeof part === 'string')
            ? content.join('\n')
            : content,
        status: block.is_error ? 'error' : 'completed',
      });
    } else if (block.type === 'text' || block.type === 'thinking') {
      this.add({
        id,
        kind: block.type === 'thinking' ? 'reasoning' : 'message',
        title:
          block.type === 'thinking'
            ? 'Reasoning'
            : role === 'user'
              ? 'You'
              : 'Agent',
        text: string(block.text ?? block.thinking),
      });
    } else
      this.add({
        id,
        kind: 'event',
        title: string(block.type) || 'Content',
        data: block,
      });
  }
  private partial(event: RecordValue) {
    const index = number(event.index) ?? 0;
    if (event.type === 'message_start') {
      this.message =
        string(object(event.message).id) || `message:${++this.sequence}`;
      this.blocks.clear();
    } else if (event.type === 'content_block_start') {
      const block = object(event.content_block);
      const id =
        block.type === 'tool_use'
          ? `${this.scope}:tool:${block.id}`
          : `${this.scope}:${this.message}:${index}`;
      this.blocks.set(index, { id, json: '' });
      this.block(block, id);
    } else if (event.type === 'content_block_delta') {
      const block = this.blocks.get(index);
      if (!block) {
        this.add({ kind: 'event', title: 'Partial content', data: event });
        return;
      }
      const item = this.items.find((entry) => entry.id === block.id);
      if (!item) return;
      const delta = object(event.delta);
      if (delta.type === 'input_json_delta') {
        block.json += string(delta.partial_json);
        this.add({ ...item, input: outputValue(block.json) });
      } else if (
        delta.type === 'text_delta' ||
        delta.type === 'thinking_delta'
      ) {
        this.add({
          ...item,
          text: (item.text ?? '') + string(delta.text ?? delta.thinking),
        });
      }
    } else if (
      !['content_block_stop', 'message_delta', 'message_stop'].includes(
        string(event.type),
      )
    ) {
      this.add({
        kind: 'event',
        title: string(event.type) || 'Stream event',
        data: event,
      });
    }
  }
}
