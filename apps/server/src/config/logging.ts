import type { LogLevel as NestLogLevel } from '@nestjs/common';
import type { LogLevel } from './deploy-config';

/**
 * `ROCKY_LOG_LEVEL` uses the conventional level names an operator expects to
 * type; Nest names two of them differently (`log` for info, `verbose` for
 * trace) and takes the enabled set rather than a floor. This is the one place
 * that translation happens.
 */
const NEST_LEVELS: Record<LogLevel, NestLogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

export function nestLogLevels(level: LogLevel): NestLogLevel[] {
  return NEST_LEVELS[level];
}
