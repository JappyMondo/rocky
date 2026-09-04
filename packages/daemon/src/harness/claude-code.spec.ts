import { describe, expect, it } from 'vitest';

import { claudeCode } from './claude-code.js';

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
