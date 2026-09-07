import { createHash } from 'node:crypto';
import type { ReviewThread } from '@rocky/sdk';
import { refuse } from './http.js';

export function replyIntent(
  thread: ReviewThread,
  body: string,
  runId: string,
  notes: string[],
) {
  const key = createHash('sha256')
    .update(JSON.stringify([runId, thread.pr.repo, thread.pr.id, thread.id]))
    .digest('hex');
  const prefix = `<!-- rocky-reply:${key}:`;
  const marker = `${prefix}${createHash('sha256').update(body).digest('hex')} -->`;
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
