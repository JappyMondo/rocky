import { spawn } from 'node:child_process';
import { startCommand } from './process.ts';

let boots = 0;
let waiting;
let requesting;
process.on('message', async (message) => {
  if (message.type === 'reply') {
    process.send({
      type: 'event',
      runId: requesting.run.runId,
      stepKey: 'reply',
      event: message,
    });
    if (requesting.run.branch === 'request-early') return;
    if (requesting.run.branch === 'request-exit') process.exit(17);
    if (message.error) process.send({ type: 'error', error: message.error });
    else
      process.send({
        type: 'result',
        result: {
          status: 'parked',
          reason: 'ci',
          boot: boots,
          replayed: 0,
          executed: 0,
        },
      });
    return;
  }
  if (message.type === 'abort' && waiting) {
    process.send({
      type: 'event',
      runId: waiting.run.runId,
      stepKey: 'fixture',
      event: 'aborted',
    });
    process.send({
      type: 'result',
      result: {
        status: 'parked',
        reason: 'ci',
        boot: boots,
        replayed: 0,
        executed: 0,
      },
    });
    return;
  }
  if (message.type !== 'boot') return;
  boots++;
  if (message.run.branch.startsWith('request')) {
    requesting = message;
    if (message.run.branch === 'request-wait')
      process.send({
        type: 'event',
        runId: message.run.runId,
        stepKey: 'request',
        event: process.pid,
      });
    process.send({
      type: 'request',
      id: 'request-1',
      request: message.run.issue.description
        ? JSON.parse(message.run.issue.description)
        : { kind: 'workspace' },
    });
    if (message.run.branch === 'request-early') {
      process.send({
        type: 'result',
        result: {
          status: 'parked',
          reason: 'ci',
          boot: boots,
          replayed: 0,
          executed: 0,
        },
      });
      process.send({
        type: 'event',
        runId: message.run.runId,
        stepKey: 'early-result',
        event: null,
      });
    }
    return;
  }
  if (message.run.branch === 'detached') {
    const command = startCommand(
      `exec "${process.execPath}" -e 'setInterval(() => {}, 1000)'`,
      { cwd: message.root, background: true },
    );
    const result = await command.result;
    process.send({
      type: 'event',
      runId: message.run.runId,
      stepKey: 'fixture',
      event: { pid: process.pid, descendant: result.pid },
    });
    while (true) {
      /* Its exec supervisor must survive this blocked event loop. */
    }
  }
  if (message.run.branch === 'blocked') {
    const descendant = spawn(
      process.execPath,
      [
        '-e',
        `
      process.on('SIGTERM', () => {});
      process.send('ready');
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    descendant.once('message', () => {
      process.send({
        type: 'event',
        runId: message.run.runId,
        stepKey: 'fixture',
        event: { pid: process.pid, descendant: descendant.pid },
      });
      while (true) {
        /* Deliberately block abort and signal handlers. */
      }
    });
    return;
  }
  process.send({
    type: 'event',
    runId: message.run.runId,
    stepKey: 'fixture',
    event: {
      pid: process.pid,
      boots,
      kind: message.kind,
      root: message.root,
      port: message.config.server.port,
    },
  });
  if (message.run.branch === 'cooperative') {
    waiting = message;
    return;
  }
  if (message.run.branch === 'error') {
    process.send({
      type: 'error',
      error: {
        name: 'FixtureError',
        message: 'disk unavailable',
        stack: 'fixture stack',
      },
    });
    return;
  }
  if (message.run.branch === 'exit') process.exit(17);
  const status = message.run.branch;
  const result =
    status === 'finished'
      ? { status, outcome: 'merged', boot: boots }
      : status === 'failed'
        ? {
            status,
            error: { name: 'Error', message: 'fixture failure' },
            boot: boots,
          }
        : status === 'ready' || status === 'cancelled'
          ? { status, boot: boots }
          : { status: 'parked', reason: 'ci', boot: boots };
  process.send({
    type: 'result',
    result: { ...result, replayed: 0, executed: 0 },
  });
});
