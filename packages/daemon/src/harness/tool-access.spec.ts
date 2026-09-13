import { expect, it } from 'vitest';
import { parseOpencodeStream } from './opencode.js';
import { parseClaudeStream } from './claude-code.js';

it('fails once on an OpenCode permission rejection instead of allowing a tool loop', () => {
  expect(() =>
    parseOpencodeStream([
      JSON.stringify({
        type: 'tool_use',
        sessionID: 's',
        part: {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'error',
            error: 'PermissionDeniedError: permission denied for bash',
          },
        },
      }),
    ]),
  ).toThrow(/bash.*(?:denied|access)/i);
});

it('recognizes a Claude denied tool result, without treating normal missing files as a grant failure', () => {
  expect(() =>
    parseClaudeStream([
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        session_id: 's',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              is_error: true,
              content: [{ type: 'text', text: 'Permission denied for Bash' }],
            },
          ],
        },
      }),
    ]),
  ).toThrow(/Bash.*denied/);
  expect(() =>
    parseOpencodeStream([
      JSON.stringify({
        type: 'tool_use',
        sessionID: 's',
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'error', error: 'File not found: optional.txt' },
        },
      }),
    ]),
  ).not.toThrow();
});
