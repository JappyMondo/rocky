#!/usr/bin/env node
// Synthetic CLI boundary fixture. Never represented as a real Harness stream.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.FIXTURE_MODE;
const emit = (value) => console.log(JSON.stringify(value));
async function hang(claude, sessionId) {
  process.on('SIGTERM', () => undefined);
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  const text = JSON.stringify({ pid: child.pid });
  if (claude) {
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: {
        content: [
          { type: 'text', text },
          { type: 'tool_use', id: 't1', name: 'Bash' },
        ],
      },
    });
    emit({
      type: 'user',
      session_id: sessionId,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    });
  } else {
    emit({ type: 'text', sessionID: sessionId, part: { type: 'text', text } });
    emit({
      type: 'tool_use',
      sessionID: sessionId,
      part: { type: 'tool', tool: 'bash', state: { status: 'completed' } },
    });
    emit({
      type: 'step_finish',
      sessionID: sessionId,
      part: { type: 'step-finish', reason: 'tool-calls' },
    });
  }
  await new Promise(() => setInterval(() => undefined, 1000));
}
if (args.includes('--output-format')) {
  const configPath = args[args.indexOf('--mcp-config') + 1];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const session_id =
    mode === 'wrong-session'
      ? '22222222-2222-4222-8222-222222222222'
      : args[
          args.indexOf(
            args.includes('--resume') ? '--resume' : '--session-id',
          ) + 1
        ];
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id }));
  if (mode === 'missing-result') process.exit(0);
  if (mode === 'hang') await hang(true, session_id);
  if (mode === 'auth-error') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id,
      result: 'oauth_org_not_allowed',
    });
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id,
      result: JSON.stringify({
        args,
        config,
        configPath,
        native: process.env.CLAUDE_CONFIG_DIR,
      }),
    }),
  );
  process.exit(mode === 'nonzero' ? 7 : 0);
}
const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
if (args[0] === 'debug') {
  if (mode === `malformed-${args[1]}`) {
    console.log('not JSON');
    process.exit(0);
  }
  console.log(
    JSON.stringify(
      args[1] === 'agent'
        ? {
            permission: Object.entries(
              mode === 'wide-agent' ? { '*': 'allow' } : config.permission,
            ).map(([permission, action]) => ({
              permission,
              action,
              pattern: '*',
            })),
          }
        : {
            ...config,
            plugin: [],
            ...(mode === 'wide-policy' ? { permission: { '*': 'allow' } } : {}),
          },
    ),
  );
} else {
  if (mode === 'stderr-only') {
    console.error('Unknown model');
    process.exit(1);
  }
  if (mode === 'large') {
    process.stdout.write('x'.repeat(33 * 1024 * 1024));
    await new Promise((resolve) => process.stdout.write('', resolve));
    process.exit(0);
  }
  if (mode === 'no-newline') {
    const text = JSON.stringify({
      type: 'text',
      sessionID: 'ses_fixture',
      part: { type: 'text', text: 'caf\u00e9' },
    });
    const bytes = Buffer.from(text);
    const split = bytes.indexOf(Buffer.from('\u00e9')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) =>
      process.stdout.write(bytes.subarray(split), resolve),
    );
    process.exit(0);
  }
  console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture' }));
  if (mode === 'hang') await hang(false, 'ses_fixture');
  if (mode === 'model-error') {
    emit({
      type: 'error',
      error: {
        name: 'ProviderModelNotFoundError',
        data: { message: 'Unknown model custom/not-a-model' },
      },
    });
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      type: 'text',
      sessionID: 'ses_fixture',
      part: {
        type: 'text',
        text: JSON.stringify({
          args,
          cwd: process.cwd(),
          db: process.env.OPENCODE_DB,
        }),
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_fixture',
      part: { type: 'step-finish', reason: 'stop' },
    }),
  );
  process.exit(mode === 'nonzero' ? 7 : 0);
}
