#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { createPublicIngress } from './public-ingress.js';

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new InvalidArgumentError('must be an integer from 1 to 65535');
  }
  return parsed;
}

const command = new Command('rocky-ingress')
  .description(
    'Webhook, ping and OAuth-callback filtering proxy. Point your BYO tunnel here, never at the daemon.',
  )
  .option('--port <port>', 'Loopback filter port.', port, 7626)
  .option('--daemon-port <port>', 'Loopback daemon port.', port, 7625)
  .parse();
const options = command.opts<{ port: number; daemonPort: number }>();
if (options.port === options.daemonPort)
  command.error('filter and daemon ports must differ');
const server = createPublicIngress(options.daemonPort);
server.on('error', () => {
  console.error(
    'Cannot bind the ingress filter. Check --port and stop any other filter on that port.',
  );
  process.exitCode = 1;
});
server.listen(options.port, '127.0.0.1', () => {
  console.log(
    `Webhook/ping/OAuth-callback ingress on http://127.0.0.1:${options.port}`,
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
