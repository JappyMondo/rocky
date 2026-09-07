import { createHash, createHmac } from 'node:crypto';
import type { ReviewThread } from '@rocky/sdk';
import { refuse } from './http.js';

export function replyIntent(
  thread: ReviewThread,
  body: string,
  runId: string,
  notes: string[],
  authorSecret: string,
) {
  // The marker is a platform-author-bound MAC, not a claim that any commenter
  // can forge from predictable Run metadata. Never put authorSecret on-wire.
  const key = createHmac('sha256', authorSecret)
    .update(
      JSON.stringify([
        'rocky-reply-v2',
        runId,
        thread.pr.repo,
        thread.pr.id,
        thread.id,
      ]),
    )
    .digest('hex');
  const prefix = `<!-- rocky-reply:v2:${key}:`;
  const marker = `${prefix}${createHmac('sha256', authorSecret)
    .update(JSON.stringify([key, body]))
    .digest('hex')} -->`;
  if (notes.some((note) => note.includes(prefix) && !note.includes(marker)))
    throw refuse(
      thread.pr.repo,
      'blocked_status',
      'This manual Run already replied to the thread with a different intent.',
      'Start a later manual Run to address a new human reply.',
      thread.pr,
    );
  return {
    exists: notes.some((note) => note.includes(marker)),
    body: `${body}\n\n${marker}`,
  };
}

export function replyScope(
  platformRoot: string,
  project: string,
  threadId: string,
  authorSecret: string,
): string {
  return createHmac('sha256', authorSecret)
    .update(
      JSON.stringify(['rocky-reply-scope-v2', platformRoot, project, threadId]),
    )
    .digest('hex');
}

// This is only a live-process coalescer. The platform marker remains the
// recovery record after a crash or an effect-before-journal interruption.
const inFlight = new Map<string, Promise<void>>();

export async function coalesceReply(
  scope: string,
  intentBody: string,
  effect: () => Promise<void>,
): Promise<void> {
  const key = createHash('sha256')
    .update(`${scope}\0${intentBody}`)
    .digest('hex');
  const active = inFlight.get(key);
  if (active) return await active;
  const pending = effect();
  inFlight.set(key, pending);
  try {
    await pending;
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}
