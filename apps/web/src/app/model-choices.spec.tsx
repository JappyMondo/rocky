import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelChoices } from './model-choices';

afterEach(cleanup);

it('selects Codex and asks for a fresh model and effort', () => {
  const onChange = vi.fn();
  const slots = { review: { name: 'Review' } };
  const { rerender } = render(
    <ModelChoices
      slots={slots}
      value={{
        review: { harness: 'opencode', model: 'old/model', effort: 'high' },
      }}
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText('Review harness'), {
    target: { value: 'codex' },
  });
  expect(onChange).toHaveBeenCalledWith({
    review: { harness: 'codex', model: '', effort: '' },
  });
  rerender(
    <ModelChoices
      slots={slots}
      value={{
        review: { harness: 'codex', model: 'selected-model', effort: 'xhigh' },
      }}
      onChange={onChange}
    />,
  );
  expect(screen.getByPlaceholderText('Full Codex model ID')).toBeTruthy();
  expect(screen.getByLabelText('Review effort')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Review model'), {
    target: { value: 'different-model' },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    review: { harness: 'codex', model: 'different-model', effort: 'xhigh' },
  });
});
