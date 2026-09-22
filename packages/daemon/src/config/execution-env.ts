import type { SourceControlSettings } from '@rocky/local-contracts';
import type { readCredentials } from './store.js';

/** Profile-owned environment: repository config cannot inject a Run variable. */
export function profileEnv(
  run: {
    profile?: {
      sourceControl?: SourceControlSettings;
      settings: { env: Record<string, string>; secretEnv: string[] };
    };
    repo: string;
  },
  credentials: Awaited<ReturnType<typeof readCredentials>>,
): Record<string, string> {
  const profile = run.profile;
  if (!profile)
    throw new Error(
      `${run.repo}: missing local profile snapshot; re-delegate after assigning a profile.`,
    );
  const stored = credentials.repos[run.repo] ?? {};
  return {
    ...profile.settings.env,
    ...Object.fromEntries(
      [
        ...new Set([
          ...profile.settings.secretEnv,
          ...[
            profile.sourceControl?.github?.tokenEnv,
            profile.sourceControl?.gitlab?.tokenEnv,
          ].filter((name): name is string => Boolean(name)),
        ]),
      ].flatMap((name) => {
        const value = stored[name] ?? process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
  };
}
