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

it('accepts Linear autolinking bare URLs without losing changed targets or code', () => {
  expect(
    sameMarkdown(
      'See https://gitlab.test/mr/7 now.',
      'See [https://gitlab.test/mr/7](<https://gitlab.test/mr/7>) now.',
    ),
  ).toBe(true);
  expect(
    sameMarkdown(
      'https://gitlab.test/mr/7',
      '[https://gitlab.test/mr/7](https://evil.test)',
    ),
  ).toBe(false);
  expect(
    sameMarkdown(
      '`https://gitlab.test/mr/7`',
      '[https://gitlab.test/mr/7](https://gitlab.test/mr/7)',
    ),
  ).toBe(false);
});

it('does not equate relative links with ordinary text', () => {
  expect(sameMarkdown('approve', '[approve](approve)')).toBe(false);
});
