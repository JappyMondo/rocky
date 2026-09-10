import { expect, it } from 'vitest';
import { sameActivityContent, sameMarkdown } from './markdown.js';
it('accepts Linear link and heading normalization without accepting different content', () => {
  expect(
    sameActivityContent(
      {
        type: 'error',
        body: '[Open Run](http://localhost:7625/runs/NG-692-3)\n\n## CI\nNot reported.',
      },
      {
        type: 'error',
        body: '[Open Run](<http://localhost:7625/runs/NG-692-3>)\n\n## CI\n\nNot reported.',
      },
    ),
  ).toBe(true);
  expect(
    sameMarkdown('[Open](https://good.test)', '[Open](https://other.test)'),
  ).toBe(false);
  expect(sameMarkdown('```\na\n\nb\n```', '```\na\nb\n```')).toBe(false);
  expect(
    sameActivityContent(
      { type: 'error', body: 'Failed' },
      { type: 'response', body: 'Failed' },
    ),
  ).toBe(false);
});
