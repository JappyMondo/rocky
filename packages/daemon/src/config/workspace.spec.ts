import { expect, it } from 'vitest';
import {
  automationSettings,
  commandRecipe,
  defaultFlowSettings,
  materializeConfiguration,
  parseFlow,
  proposeConfiguration,
  serviceRecipe,
  validateConfiguration,
  type WorkspaceConfiguration,
} from '@rocky/local-contracts';
const source = () =>
  JSON.stringify({
    version: 2,
    name: 'test',
    models: {},
    settings: defaultFlowSettings(),
    nodes: [],
    edges: [],
  });
const config = (): WorkspaceConfiguration => ({
  automation: automationSettings(),
  repos: [
    {
      id: 'frontend-id',
      name: 'frontend',
      url: 'https://github.com/example/frontend',
      baseBranch: 'main',
      commands: [
        {
          ...commandRecipe('test', 'npm test'),
          purpose: 'test',
          policy: 'required',
        },
      ],
      services: [{ ...serviceRecipe('web'), start: 'npm start' }],
    },
  ],
});

it('requires a port variable only for assigned ports and rejects invalid variable names', () => {
  const value = config();
  const service = value.repos[0].services![0];
  service.portEnv = '';
  expect(() => validateConfiguration(value)).toThrow(
    'Invalid port environment variable',
  );
  service.endpoints[0].locator = {
    kind: 'fixed',
    url: 'http://localhost:4173',
  };
  expect(() => validateConfiguration(value)).not.toThrow();
  service.portEnv = 'invalid-name';
  expect(() => validateConfiguration(value)).toThrow(
    'Invalid port environment variable',
  );
});

it('proposes all legacy settings without silently selecting conflicting commands', () => {
  const flow = parseFlow(source());
  flow.settings.commands.test = 'npm test';
  flow.settings.repositories = {
    frontend: {
      commands: { test: 'pnpm test', lint: 'pnpm lint' },
      ui: [
        {
          id: 'web',
          start: 'pnpm dev',
          endpoint: { kind: 'output-regex', pattern: 'port (?<port>[0-9]+)' },
        },
      ],
    },
  };
  const migration = proposeConfiguration({
    repos: [
      { name: 'frontend', url: 'https://example.org/a', baseBranch: 'main' },
    ],
    source: JSON.stringify(flow),
    settings: { testCommand: 'yarn test' },
  });
  expect(migration.conflicts).toHaveLength(1);
  expect(
    migration.conflicts[0].choices.map((choice) =>
      'command' in choice.value ? choice.value.command : '',
    ),
  ).toEqual(['pnpm test', 'npm test', 'yarn test']);
  expect(
    migration.repos[0].commands?.map((command) => command.command),
  ).toEqual(['pnpm lint']);
  expect(migration.repos[0].services?.[0].endpoints[0].locator.kind).toBe(
    'output-regex',
  );
});
it('keeps stable command references after renaming and snapshots resolved settings without editing the source', () => {
  const next = config();
  next.repos[0].name = 'renamed';
  const flow = parseFlow(source());
  flow.nodes = [
    {
      id: 'check',
      name: 'Check',
      type: 'command',
      parameters: { recipe: 'frontend-id/test' },
      position: { x: 0, y: 0 },
    },
  ];
  next.automation.reviewCap = 7;
  const encoded = JSON.stringify(flow);
  const frozen = materializeConfiguration(encoded, next);
  expect(parseFlow(frozen).settings.execution?.[0].name).toBe('renamed');
  expect(parseFlow(frozen).settings.reviewCap).toBe(7);
  expect(parseFlow(encoded).settings.execution).toBeUndefined();
  next.repos[0].commands![0].command = 'changed';
  expect(parseFlow(frozen).settings.execution?.[0].commands?.[0].command).toBe(
    'npm test',
  );
  next.repos[0].commands = [];
  expect(() => materializeConfiguration(encoded, next)).toThrow(
    'missing repository command',
  );
});
it('rejects escaping paths, dangling dependencies, dependency cycles and malformed endpoints', () => {
  const next = config();
  next.repos[0].commands![0].cwd = '../outside';
  expect(() => validateConfiguration(next)).toThrow('Working directory');
  next.repos[0].commands![0].cwd = '.';
  next.repos[0].commands![0].dependsOn = ['missing/install'];
  expect(() => validateConfiguration(next)).toThrow('Unknown dependency');
  next.repos[0].commands![0].dependsOn = ['frontend-id/test'];
  expect(() => validateConfiguration(next)).toThrow('Dependency cycle');
  next.repos[0].commands![0].dependsOn = [];
  next.repos[0].services![0].endpoints[0].locator = {
    kind: 'fixed',
    url: 'javascript:alert(1)',
  };
  expect(() => validateConfiguration(next)).toThrow('HTTP(S)');
});
