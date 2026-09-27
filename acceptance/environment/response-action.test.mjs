import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { responseAction } from "./response-action.mjs";

test("action rejection cancels response observer without late unhandled rejection", async () => {
  const page = new EventEmitter();
  let cleaned = false;
  try {
    await assert.rejects(
      responseAction(
        page,
        () => true,
        async () => {
          throw Error("action-failed");
        },
        20,
      ),
      /action-failed/,
    );
  } finally {
    cleaned = true;
  }
  page.emit("close");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cleaned, true);
  assert.equal(page.listenerCount("response"), 0);
  assert.equal(page.listenerCount("close"), 0);
});
test("page close settles pending response and action before outcome/cleanup", async () => {
  const page = new EventEmitter();
  let actionEnded = false,
    outcome,
    cleaned = false;
  try {
    await responseAction(
      page,
      () => false,
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        page.emit("close");
        actionEnded = true;
      },
      30,
    );
  } catch (error) {
    outcome = error.message;
  } finally {
    cleaned = true;
  }
  assert.equal(outcome, "response-action-page-closed");
  assert.equal(actionEnded, true);
  assert.equal(cleaned, true);
  assert.equal(page.listenerCount("response"), 0);
});
test("deadline does not leave a response observer or unawaited action", async () => {
  const page = new EventEmitter();
  let finished = false;
  await assert.rejects(
    responseAction(
      page,
      () => false,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        finished = true;
      },
      5,
    ),
    (e) => e.name === "TimeoutError",
  );
  assert.equal(finished, true);
  assert.equal(page.listenerCount("response"), 0);
});
