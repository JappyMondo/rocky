// A response and its UI action have one lifetime. No detached Playwright waiter
// can reject after an action failure or browser close and terminate the process.
export async function responseAction(
  page,
  predicate,
  action,
  timeoutMs = 15000,
) {
  let resolve,
    reject,
    timer,
    settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    error ? reject(error) : resolve(value);
  };
  const waiting = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  waiting.catch(() => {}); // Attach immediately, before action dispatch.
  const onResponse = (response) => {
    try {
      if (predicate(response)) finish(undefined, response);
    } catch (error) {
      finish(error);
    }
  };
  const onClose = () => finish(Error("response-action-page-closed"));
  page.on("response", onResponse);
  page.on("close", onClose);
  timer = setTimeout(() => {
    const error = Error("response-action-timeout");
    error.name = "TimeoutError";
    finish(error);
  }, timeoutMs);
  const executing = Promise.resolve().then(action);
  try {
    const [response] = await Promise.all([waiting, executing]);
    return response;
  } finally {
    finish(Error("response-action-cancelled"));
    clearTimeout(timer);
    page.off("response", onResponse);
    page.off("close", onClose);
    await Promise.allSettled([waiting, executing]);
  }
}
