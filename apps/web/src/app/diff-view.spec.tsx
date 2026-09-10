import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffView } from '@rocky/local-contracts';

import { DiffViewer } from './diff-view.js';

afterEach(cleanup);

const diff: DiffView = {
  id: 'recorded-revision',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  availability: 'available',
  files: [
    {
      path: 'src/a.ts',
      kind: 'file',
      status: 'modified',
      hunks: [
        {
          header: '@@ -4,1 +4,1 @@',
          lines: [
            { kind: 'delete', text: 'old()', baseLine: 4 },
            { kind: 'add', text: 'new()', headLine: 4 },
          ],
        },
      ],
    },
    { path: 'src/ui', kind: 'directory', status: 'modified', hunks: [] },
    { path: 'gone.ts', kind: 'missing', status: 'deleted', hunks: [] },
  ],
  annotations: [
    {
      id: 'base',
      stepKey: '1/0/0',
      revision: 'recorded-revision',
      file: 'src/a.ts',
      line: 4,
      side: 'base',
      text: 'This old behavior fails.',
      state: 'open',
    },
    {
      id: 'head',
      stepKey: '2/0/0',
      revision: 'recorded-revision',
      file: 'src/a.ts',
      line: 4,
      side: 'head',
      text: 'Confirm the new behavior.',
      state: 'fixed',
      resolution: { stepKey: '2/0/0', label: 'fixed by fixer' },
      screenshots: [{ id: `s_${'a'.repeat(32)}`, caption: 'result' }],
    },
    {
      id: 'directory',
      stepKey: '3/0/0',
      revision: 'recorded-revision',
      file: 'src/ui',
      text: 'Folder naming is unclear.',
      state: 'disagreed',
      resolution: {
        stepKey: '3/0/1',
        label: 'kept naming',
        reason: 'matches package boundary',
      },
    },
    {
      id: 'missing',
      stepKey: '4/0/0',
      revision: 'old-revision',
      file: 'gone.ts',
      line: 2,
      side: 'head',
      text: 'Never place me on current code.',
      state: 'withdrawn',
      resolution: {
        stepKey: '4/0/0',
        label: 'withdrawn',
        reason: 'file was removed',
      },
    },
  ],
};

function view(value = diff) {
  const onClose = vi.fn();
  render(<DiffViewer diff={value} onClose={onClose} />);
  return onClose;
}

describe('DiffViewer', () => {
  it('renders unified base/head anchors, state labels, and opaque screenshot links', () => {
    view();
    expect(screen.getByText('This old behavior fails.')).toBeTruthy();
    expect(screen.getByText('Confirm the new behavior.')).toBeTruthy();
    expect(screen.getByText('Fixed Complaint')).toBeTruthy();
    expect(screen.getByText('✓ resolved by fixed by fixer')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Screenshot: result' })
        .getAttribute('href'),
    ).toBe(`/api/screenshots/s_${'a'.repeat(32)}`);
  });

  it('keeps directory and historical Complaints at their owning headers', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: /src\/ui/ }));
    expect(screen.getByText('Folder naming is unclear.')).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent ===
          'Resolution · kept naming — matches package boundary',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /gone\.ts/ }));
    expect(screen.getByText('Never place me on current code.')).toBeTruthy();
    expect(screen.getByText(/Old revision old-revision/)).toBeTruthy();
  });

  it('uses real controls and its own keyboard navigation without leaking to a parent', () => {
    const onClose = view();
    const viewer = screen.getByLabelText('Diff viewer');
    const parent = vi.fn();
    viewer.parentElement?.addEventListener('keydown', parent);
    fireEvent.keyDown(viewer, { key: 'j' });
    expect(
      screen.getByText('Directory anchor; it has no line-level diff.'),
    ).toBeTruthy();
    expect(parent).not.toHaveBeenCalled();
    fireEvent.keyDown(viewer, { key: 'n' });
    expect(screen.getByText('This old behavior fails.')).toBeTruthy();
    fireEvent.keyDown(viewer, { key: 'u' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves a present selected file across a refreshed diff and keeps headers and Complaints when pruned', () => {
    const { rerender } = render(
      <DiffViewer diff={diff} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /src\/ui/ }));
    rerender(
      <DiffViewer
        diff={{ ...diff, headSha: 'newhead' }}
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByText('Directory anchor; it has no line-level diff.'),
    ).toBeTruthy();
    rerender(
      <DiffViewer
        diff={{ ...diff, availability: 'pruned' }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Diff content was pruned',
    );
    expect(
      screen.getByRole('navigation', { name: 'Changed files' }),
    ).toBeTruthy();
    expect(screen.getByText('Folder naming is unclear.')).toBeTruthy();
  });

  it('moves through every Complaint on the same file and supports touch controls', () => {
    view();
    const viewer = screen.getByLabelText('Diff viewer');

    fireEvent.keyDown(viewer, { key: 'n' });
    expect(document.activeElement?.textContent).toContain(
      'This old behavior fails.',
    );
    fireEvent.keyDown(viewer, { key: 'n' });
    expect(document.activeElement?.textContent).toContain(
      'Confirm the new behavior.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous Complaint' }));
    expect(document.activeElement?.textContent).toContain(
      'This old behavior fails.',
    );
  });

  it('shows a synthetic missing anchor and unavailable line context without guessing', () => {
    const value: DiffView = {
      ...diff,
      annotations: [
        ...diff.annotations,
        {
          id: 'missing-line',
          stepKey: '5/0/0',
          revision: 'recorded-revision',
          file: 'not-in-files.ts',
          line: 99,
          side: 'head',
          text: 'This source anchor was not recorded.',
          state: 'open',
        },
        {
          id: 'wrong-line',
          stepKey: '6/0/0',
          revision: 'recorded-revision',
          file: 'src/a.ts',
          line: 99,
          side: 'head',
          text: 'This line does not exist in the hunk.',
          state: 'open',
        },
      ],
    };

    view(value);
    fireEvent.click(screen.getByRole('button', { name: /not-in-files\.ts/ }));
    expect(
      screen.getByText('This source anchor was not recorded.'),
    ).toBeTruthy();
    expect(
      screen.getByText(/file or directory anchor is missing/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    expect(
      screen.getByText('This line does not exist in the hunk.'),
    ).toBeTruthy();
    expect(screen.getByText(/head line 99 was not found/)).toBeTruthy();
  });

  it('auto-focuses the viewer, restores focus on close, and leaves modified or select keys alone', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open diff';
    document.body.append(opener);
    opener.focus();
    const onClose = view();
    const viewer = screen.getByLabelText('Diff viewer');
    const parent = vi.fn();
    viewer.parentElement?.addEventListener('keydown', parent);

    expect(document.activeElement).toBe(viewer);
    fireEvent.keyDown(viewer, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'n' });
    expect(document.activeElement).toBe(viewer);
    expect(parent).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(viewer, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

it('contains keyboard focus in the diff dialog and skips controls hidden at the current viewport', () => {
  view();
  const viewer = screen.getByRole('dialog', { name: 'Diff viewer' });
  const visible = new Set([
    screen.getByRole('button', { name: 'Previous Complaint' }),
    screen.getByRole('button', { name: 'Next Complaint' }),
    screen.getByRole('button', { name: 'Close diff viewer' }),
  ]);
  const rects = vi
    .spyOn(HTMLElement.prototype, 'getClientRects')
    .mockImplementation(function (this: HTMLElement) {
      return { length: visible.has(this) ? 1 : 0 } as DOMRectList;
    });
  const first = screen.getByRole('button', { name: 'Previous Complaint' });
  const last = screen.getByRole('button', { name: 'Close diff viewer' });
  first.focus();
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  viewer.focus();
  fireEvent.keyDown(viewer, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(first, { key: 'Tab' });
  rects.mockRestore();
});
