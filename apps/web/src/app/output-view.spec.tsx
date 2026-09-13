import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CodeOutput, OutputValue, Prose } from './output-view.js';
import { TranscriptView } from './transcript-view.js';
import { TranscriptDecoder, type Transcript } from './transcript.js';
vi.mock('./workflow-diagram.js', () => ({
  Chart: ({ source }: { source: string }) => <div>Diagram: {source}</div>,
}));
afterEach(cleanup);
const transcript = (changes: Partial<Transcript> = {}): Transcript => ({
  items: [],
  raw: '',
  omitted: 0,
  rawTruncated: false,
  pending: false,
  ...changes,
});

it('renders schema fields, nested lists, Markdown tables, task lists, and shell output', () => {
  render(
    <OutputValue
      value={{
        summary: '**Complete**',
        steps: ['Inspect `src`', { checks: [true, false, null] }],
        ci: { lint: 'passed' },
        stdout: 'a\n  b',
        empty: [],
        fields: {},
        table: '| Tool | Status |\n| --- | --- |\n| read | done |',
        tasks: '- [x] Verified',
      }}
    />,
  );
  expect(screen.getByText('Complete').tagName).toBe('STRONG');
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByRole('checkbox').hasAttribute('checked')).toBe(true);
  expect(screen.getByText('a b').tagName).toBe('PRE');
  expect(screen.getByText('None')).toBeTruthy();
  expect(screen.getByText('No fields')).toBeTruthy();
  expect(screen.getByText('null')).toBeTruthy();
  expect(screen.getByText('false')).toBeTruthy();
});
it('keeps executable HTML and unsafe URLs inert and renders diagrams on demand', () => {
  const view = render(
    <Prose
      text={
        '<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n[safe](https://example.com)\n\n![proof](https://example.com/image.png)\n\n![](https://example.com/other.png)\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```ts\nconst x = 1\n```'
      }
    />,
  );
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.container.querySelector('img')).toBeNull();
  expect(screen.getByText('unsafe').getAttribute('href')).toBe('');
  expect(screen.getByRole('link', { name: 'safe' }).getAttribute('rel')).toBe(
    'noreferrer',
  );
  expect(screen.queryByText(/Diagram:/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Render diagram' }));
  expect(screen.getByText(/Diagram: flowchart/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show diagram source' }));
  expect(screen.queryByText(/Diagram:/)).toBeNull();
});
it('bounds large outputs, long arrays, and deeply nested objects with explicit expansion', () => {
  const view = render(
    <OutputValue value={Array.from({ length: 22 }, (_, i) => `Item ${i}`)} />,
  );
  expect(screen.queryByText('Item 21')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show all 22 items' }));
  expect(screen.getByText('Item 21')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer items' }));
  expect(screen.queryByText('Item 21')).toBeNull();
  view.rerender(<CodeOutput text={'a'.repeat(12001)} />);
  expect(view.container.querySelector('pre')?.textContent?.length).toBe(12000);
  fireEvent.click(
    screen.getByRole('button', { name: 'Show all 12,001 characters' }),
  );
  expect(view.container.querySelector('pre')?.textContent?.length).toBe(12001);
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
  expect(view.container.querySelector('pre')?.textContent?.length).toBe(12000);
  view.rerender(
    <OutputValue value={{ a: { b: { c: { d: { e: { f: 'deep' } } } } } }} />,
  );
  expect(view.container.querySelector('pre')?.textContent).toContain('deep');
  view.rerender(<OutputValue value={undefined} />);
  expect(view.container.textContent).toBe('');
  view.rerender(<OutputValue value={'x'.repeat(30001)} />);
  expect(view.container.querySelector('pre')).toBeTruthy();
});
it('filters and searches activity, pairs tool details, and keeps raw JSON separate', () => {
  const decoder = new TranscriptDecoder();
  const data = decoder.push(
    [
      {
        type: 'text',
        timestamp: 1788889606006,
        part: { text: 'Investigating **the failure**' },
      },
      {
        type: 'tool_use',
        part: {
          callID: 'call',
          tool: 'bash',
          state: {
            title: 'Run checks',
            status: 'error',
            input: { command: 'pnpm test' },
            error: 'Test failed',
            time: { start: 0, end: 3000 },
          },
        },
      },
      {
        type: 'tool_use',
        part: { callID: 'other', tool: 'read', state: { status: 'running' } },
      },
      { type: 'new_event', value: 'Preserved' },
      { type: 'reasoning', part: { text: 'Consider alternatives' } },
      { type: 'error', error: 'Disconnected' },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  const view = render(
    <TranscriptView
      transcript={data}
      state="loading"
      empty="Loading transcript…"
    />,
  );
  expect(screen.getByText('the failure').tagName).toBe('STRONG');
  expect(screen.queryByText('pnpm test')).toBeNull();
  const tool = screen.getByText('bash').closest('details');
  if (!tool) throw new Error('Expected tool disclosure');
  tool.open = true;
  fireEvent(tool, new Event('toggle'));
  expect(screen.getByText('pnpm test').tagName).toBe('PRE');
  expect(screen.getByText('Test failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  expect(screen.queryByText('bash')).toBeNull();
  expect(screen.getByText('Reasoning')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
  expect(screen.queryByText('the failure')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'PNPM' },
  });
  expect(screen.getByText('bash')).toBeTruthy();
  expect(screen.queryByText('read')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'absent' },
  });
  expect(screen.getByText('No matching activity.')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
  expect(screen.getByText('Agent error')).toBeTruthy();
  expect(screen.getByText('bash')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
  expect(view.container.querySelector('pre')?.textContent).toContain(
    'tool_use',
  );
  expect(screen.queryByRole('searchbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  const unknown = screen.getByText('new_event').closest('details');
  if (!unknown) throw new Error('Expected unknown event disclosure');
  unknown.open = true;
  fireEvent(unknown, new Event('toggle'));
  expect(screen.getByText('Preserved')).toBeTruthy();
});
it('shows earlier activity on demand, visible retention limits, follow latest, and stream failures alongside received data', () => {
  const data = transcript({
    items: Array.from({ length: 81 }, (_, i) => ({
      id: String(i),
      kind: 'message',
      title: 'Agent',
      text: `Message ${i}`,
    })),
    raw: 'raw line',
    rawTruncated: true,
    omitted: 4,
    pending: true,
  });
  const view = render(
    <TranscriptView
      transcript={data}
      state="loading"
      empty="Loading transcript…"
    />,
  );
  expect(screen.queryByText('Message 0')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Show 1 earlier entries' }),
  );
  expect(screen.getByText('Message 0')).toBeTruthy();
  expect(screen.getByText(/4 earlier entries omitted/)).toBeTruthy();
  expect(screen.getByText('Receiving the next event…')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Follow latest' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  view.rerender(
    <TranscriptView
      transcript={data}
      state="error"
      empty="Transcript could not be read."
    />,
  );
  expect(screen.getByText(/Previously received activity/)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Connection interrupted');
  fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
  expect(screen.getByText(/last 200,000 raw characters/)).toBeTruthy();
  view.rerender(
    <TranscriptView
      transcript={transcript()}
      state="settled"
      empty="Nothing recorded"
    />,
  );
  expect(screen.getByText('Nothing recorded')).toBeTruthy();
  view.rerender(
    <TranscriptView
      transcript={transcript()}
      state="unavailable"
      empty="Unavailable transcript"
    />,
  );
  expect(
    within(screen.getByRole('status')).getByText('Unavailable'),
  ).toBeTruthy();
});
