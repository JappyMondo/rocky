/** Stop awaiting an operation even if its implementation ignores cancellation.
 * Late outcomes are observed, but cannot resume the caller after it has aborted.
 * Resource acquisition/commit must still own its cleanup rather than be raced.
 */
export async function withAbort<T>(
  signal: AbortSignal | undefined,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
