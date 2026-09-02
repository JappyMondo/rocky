/**
 * The daemon's own lifecycle (NG-595): the pidfile it claims, the rotated log
 * it writes, and the process that owns both.
 */
export {
  inspectPidFile,
  pidIsAlive,
  readPidFile,
  removePidFile,
  writePidFile,
  type DaemonRecord,
  type InspectOptions,
  type PidFileState,
  type RemoveOptions,
} from './pidfile.js';

export {
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  rotatedLogFiles,
  rotatingLogStream,
  type RotationOptions,
} from './log-rotation.js';

export {
  DaemonAlreadyRunningError,
  runDaemon,
  type DaemonProcess,
  type RunDaemonOptions,
} from './run-daemon.js';
