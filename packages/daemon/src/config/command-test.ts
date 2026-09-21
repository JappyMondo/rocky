import { createHash } from 'node:crypto';
import { defaultFlowSettings, validateFlow } from '@rocky/local-contracts';
import type { RepositoryProfile } from './profiles.js';

/** A manual, isolated run: never edits the saved profile or publishes Linear/PR updates. */
export function commandTestProfile(
  profile: RepositoryProfile,
  selection: { repositoryId: string; commandId: string; revision: string },
): RepositoryProfile {
  if (
    selection.revision !==
    createHash('sha256').update(JSON.stringify(profile)).digest('hex')
  )
    throw Error('Profile changed. Save or reload before testing the command.');
  const repo = profile.repos?.find(
    (repo) => repo.id === selection.repositoryId,
  );
  if (
    !profile.configurationVersion ||
    !repo?.commands?.some((command) => command.id === selection.commandId)
  )
    throw Error('Save this command in a unified profile before testing it.');
  const source = JSON.stringify({
    version: 2,
    name: 'Test repository command',
    models: {},
    settings: defaultFlowSettings(),
    nodes: [
      {
        id: 'start',
        type: 'trigger',
        name: 'Test command',
        parameters: { kind: 'manual', name: 'configuration-test' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'command',
        type: 'command',
        name: `${repo.name} / ${selection.commandId}`,
        parameters: { recipe: `${repo.id}/${selection.commandId}` },
        position: { x: 200, y: 0 },
      },
      {
        id: 'passed',
        type: 'finish',
        name: 'Passed',
        parameters: { outcome: 'completed' },
        position: { x: 400, y: 0 },
      },
      {
        id: 'failed',
        type: 'finish',
        name: 'Command failed',
        parameters: { outcome: 'exhausted' },
        position: { x: 400, y: 200 },
      },
    ],
    edges: [
      {
        id: 'start-command',
        source: 'start',
        sourceHandle: 'next',
        target: 'command',
      },
      {
        id: 'success',
        source: 'command',
        sourceHandle: 'success',
        target: 'passed',
      },
      {
        id: 'failure',
        source: 'command',
        sourceHandle: 'failure',
        target: 'failed',
      },
    ],
  });
  validateFlow(source);
  return {
    ...profile,
    models: {},
    workflow: { source, triggers: ['configuration-test'] },
  };
}
