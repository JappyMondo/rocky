import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { commandTestProfile } from './command-test.js';
import { newRepositoryProfile } from './profiles.js';
import {
  commandRecipe,
  parseFlow,
  automationSettings,
} from '@rocky/local-contracts';
it('builds an isolated manual command graph without altering the saved profile or granting agents', () => {
  const profile = {
    ...newRepositoryProfile({
      id: 'test',
      repos: [
        {
          id: 'web',
          name: 'web',
          url: 'https://github.com/example/web',
          baseBranch: 'main',
          commands: [commandRecipe('test', 'npm test')],
        },
      ],
    }),
    configurationVersion: 1 as const,
    automation: automationSettings(),
  };
  const original = JSON.stringify(profile);
  const selection = {
    repositoryId: 'web',
    commandId: 'test',
    revision: createHash('sha256').update(original).digest('hex'),
  };
  const test = commandTestProfile(profile, selection);
  const flow = parseFlow(test.workflow.source);
  expect(flow.nodes.map((node) => node.type)).toEqual([
    'trigger',
    'command',
    'finish',
    'finish',
  ]);
  expect(flow.nodes[1].parameters.recipe).toBe('web/test');
  expect(test.models).toEqual({});
  expect(JSON.stringify(profile)).toBe(original);
  expect(() =>
    commandTestProfile(profile, { ...selection, revision: 'old' }),
  ).toThrow('Profile changed');
  expect(() =>
    commandTestProfile(profile, { ...selection, commandId: 'missing' }),
  ).toThrow('Save this command');
});
