#!/usr/bin/env node
// Synthetic process-boundary fixture, never a live Codex capture.
import { spawn, spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.FIXTURE_MODE;
const emit = (record) => console.log(JSON.stringify(record));
const session =
  mode === 'wrong-session'
    ? '11111111-1111-4111-8111-111111111111'
    : '0199a213-81c0-7800-8aa1-bbab2a035a53';
emit({ type: 'thread.started', thread_id: session });
emit({ type: 'turn.started' });
if (mode === 'hang') {
  process.on('SIGINT', () => undefined);
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGINT",()=>{});setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  emit({
    type: 'item.completed',
    item: {
      id: 'pid',
      type: 'agent_message',
      text: JSON.stringify({ pid: child.pid }),
    },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'tool',
      type: 'command_execution',
      status: 'completed',
      exit_code: 0,
    },
  });
  await new Promise(() => setInterval(() => undefined, 1000));
}
if (mode === 'missing-result') process.exit(0);
if (mode === 'auth-error') {
  emit({ type: 'turn.failed', error: { message: '401 Unauthorized' } });
  process.exit(1);
}
let proxyOutput;
if (mode === 'stdio') {
  const config = args.find((arg) => arg.startsWith('mcp_servers='));
  const proxy = /"args"=\["([^"]+\.mjs)"\]/.exec(config)?.[1];
  if (!proxy) throw new Error('Missing private MCP proxy');
  const result = spawnSync(process.execPath, [proxy], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Private MCP proxy failed');
  proxyOutput = JSON.parse(result.stdout);
}
emit({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    id: 'answer',
    text: JSON.stringify({
      args,
      header: process.env.ROCKY_CODEX_MCP_0_0,
      proxyOutput,
    }),
  },
});
emit({
  type: 'turn.completed',
  ...(mode === 'nonzero'
    ? {}
    : {
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
      }),
});
process.exit(mode === 'nonzero' ? 7 : 0);
