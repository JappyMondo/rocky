import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  automationSettings,
  commandRecipe,
  serviceRecipe,
  type WorkspaceRepository,
} from '@rocky/local-contracts';
import {
  ConfigurationMigrationPanel,
  AutomationSettingsFields,
  RepositorySettings,
} from './workspace-settings.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const repository = (): WorkspaceRepository => ({
  id: 'web',
  name: 'web',
  url: 'https://example.org/web',
  baseBranch: 'main',
  commands: [commandRecipe('install', 'pnpm install')],
  services: [serviceRecipe('database')],
});

function editRepositories(initial = [repository()]) {
  let current = initial;
  function Editor() {
    const [repos, setRepos] = useState(initial);
    current = repos;
    return (
      <RepositorySettings
        repos={repos}
        profileId="test"
        disabled={false}
        mismatch={() => undefined}
        onChange={setRepos}
      />
    );
  }
  render(<Editor />);
  return () => current;
}

it.each([true, false])(
  'applies discovered recipes to the draft without overwriting existing entries (catalog: %s)',
  async (catalog) => {
    const repo = repository();
    const commands = [
      commandRecipe('install', 'npm ci'),
      {
        ...commandRecipe('test', 'npm test'),
        dependsOn: ['web/install', 'external/prepare'],
      },
    ];
    const services = [
      { ...serviceRecipe('database'), start: 'pnpm database' },
      {
        ...serviceRecipe('frontend'),
        start: 'npm start',
        dependsOn: ['web/database'],
      },
    ];
    const proposal = catalog
      ? {
          catalog: { commands, services },
          commands: {},
          ui: [],
          explanation: '',
        }
      : {
          commands: { test: 'npm test' },
          ui: [
            {
              id: 'frontend',
              start: 'npm start',
              endpoint: { kind: 'fixed', url: 'http://localhost:3000' },
            },
          ],
          explanation: '',
        };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith('/verify-environment')
                ? null
                : { id: 'ready', status: 'ready', proposal },
            ),
          ),
      ),
    );
    let current = [repo];
    function Editor() {
      const [repos, setRepos] = useState(current);
      current = repos;
      return (
        <RepositorySettings
          repos={repos}
          savedRepos={[repo]}
          profileId="test"
          disabled={false}
          mismatch={() => undefined}
          onChange={setRepos}
        />
      );
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
    await screen.findByDisplayValue('npm test');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(current[0].commands?.[0]).toEqual(repo.commands?.[0]);
    if (catalog) {
      const install = current[0].commands?.[1];
      expect(install?.id).not.toBe('install');
      expect(current[0].commands?.[2].dependsOn).toEqual([
        `web/${install?.id}`,
        'external/prepare',
      ]);
    } else
      expect(current[0].commands?.[1]).toMatchObject({
        purpose: 'test',
        command: 'npm test',
      });
    fireEvent.click(screen.getByRole('button', { name: 'Dev services' }));
    await screen.findByDisplayValue('npm start');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(current[0].services?.[0]).toEqual(repo.services?.[0]);
    if (catalog) {
      const database = current[0].services?.[1];
      expect(database?.id).not.toBe('database');
      expect(current[0].services?.[2].dependsOn).toEqual([
        `web/${database?.id}`,
      ]);
    } else
      expect(current[0].services?.[1]).toMatchObject({
        name: 'frontend',
        start: 'npm start',
        endpoints: [
          {
            name: 'web',
            locator: { kind: 'fixed', url: 'http://localhost:3000' },
          },
        ],
      });
  },
);

it('adds repositories, changes their ordering and access, and preserves the remaining repository on removal', () => {
  const current = editRepositories();
  fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
  const id = current()[1].id;
  for (const [label, value] of [
    ['Folder name', 'api'],
    ['Remote URL', 'https://example.org/api'],
    ['Base branch', 'develop'],
    ['CI pipeline', 'none'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(current()[1]).toMatchObject({
    id,
    name: 'api',
    baseBranch: 'develop',
    ci: 'none',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Access' }));
  fireEvent.change(screen.getByLabelText('Commit author name'), {
    target: { value: 'custom' },
  });
  fireEvent.change(screen.getByLabelText('Commit author name value'), {
    target: { value: 'Repository bot' },
  });
  expect(current()[1].sourceControl?.git?.name).toBe('Repository bot');
  fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
  fireEvent.click(screen.getByRole('button', { name: 'Make primary' }));
  expect(current().map((repo) => repo.id)).toEqual([id, 'web']);
  fireEvent.change(
    screen.getByLabelText('Repository', { selector: 'select' }),
    { target: { value: 'web' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove repository' }));
  expect(current().map((repo) => repo.id)).toEqual([id]);
  expect(
    (
      screen.getByRole('button', {
        name: 'Remove repository',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it('edits command execution settings, validates environment JSON and manages prerequisites without changing their identities', () => {
  const current = editRepositories();
  fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add command' }));
  const card = within(screen.getByRole('group', { name: 'New command' }));
  for (const [label, value] of [
    ['Command name', 'Unit tests'],
    ['Purpose', 'test'],
    ['Shell command', 'pnpm test'],
    ['Working directory', 'frontend'],
    ['Selection', 'required'],
    ['When to use', 'Every change'],
    ['Timeout (ms)', '42000'],
  ])
    fireEvent.change(card.getByLabelText(label), { target: { value } });
  const dependency = card.getByRole('checkbox', { name: /web \// });
  fireEvent.click(dependency);
  expect(current()[0].commands?.[1].dependsOn).toEqual(['web/install']);
  fireEvent.click(dependency);
  expect(current()[0].commands?.[1].dependsOn).toEqual([]);
  const env = card.getByLabelText('Environment (JSON)');
  for (const value of ['{', '{"COUNT":1}']) {
    fireEvent.change(env, { target: { value } });
    expect(card.getByRole('alert').textContent).toContain('valid JSON');
    expect(current()[0].commands?.[1].env).toEqual({});
  }
  fireEvent.change(env, { target: { value: '{"MODE":"test"}' } });
  expect(card.queryByRole('alert')).toBeNull();
  expect(current()[0].commands?.[1]).toMatchObject({
    name: 'Unit tests',
    purpose: 'test',
    command: 'pnpm test',
    cwd: 'frontend',
    policy: 'required',
    description: 'Every change',
    timeoutMs: 42000,
    env: { MODE: 'test' },
  });
  fireEvent.click(card.getByRole('button', { name: 'Remove command' }));
  expect(current()[0].commands?.map((command) => command.id)).toEqual([
    'install',
  ]);
});

it('edits service lifecycle, endpoint discovery and readiness independently of sibling services', () => {
  const current = editRepositories();
  fireEvent.click(screen.getByRole('button', { name: 'Dev services' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add dev service' }));
  const card = within(screen.getByRole('group', { name: 'New service' }));
  for (const [label, value] of [
    ['Service name', 'Frontend'],
    ['Start command', 'pnpm dev'],
    ['Working directory', 'frontend'],
    ['Port environment variable (optional unless assigned)', 'APP_PORT'],
    ['When to use', 'UI checks'],
    ['Stop command (optional)', 'pnpm stop'],
    ['Selection', 'manual'],
    ['Readiness attempts', '12'],
    ['Readiness interval (ms)', '500'],
  ])
    fireEvent.change(card.getByLabelText(label), { target: { value } });
  fireEvent.click(card.getByRole('checkbox', { name: /web \// }));
  fireEvent.change(card.getByLabelText('Environment (JSON)'), {
    target: { value: '{"NODE_ENV":"test"}' },
  });
  const locator = card.getByLabelText('Discover endpoint from');
  fireEvent.change(locator, { target: { value: 'output-regex' } });
  fireEvent.change(card.getByLabelText('Pattern (named url or port capture)'), {
    target: { value: 'listening at (?<url>http://\\S+)' },
  });
  expect(current()[0].services?.[1].endpoints[0].locator).toMatchObject({
    kind: 'output-regex',
    pattern: 'listening at (?<url>http://\\S+)',
  });
  fireEvent.change(locator, { target: { value: 'command' } });
  fireEvent.change(
    card.getByLabelText('Resolver command (prints URL or port)'),
    { target: { value: 'cat .port' } },
  );
  expect(current()[0].services?.[1].endpoints[0].locator).toEqual({
    kind: 'command',
    command: 'cat .port',
  });
  fireEvent.change(locator, { target: { value: 'json-file' } });
  fireEvent.change(card.getByLabelText('JSON file (relative to repository)'), {
    target: { value: '.server.json' },
  });
  fireEvent.change(card.getByLabelText('JSON pointer'), {
    target: { value: '/http/port' },
  });
  expect(current()[0].services?.[1].endpoints[0].locator).toEqual({
    kind: 'json-file',
    path: '.server.json',
    pointer: '/http/port',
  });
  fireEvent.change(locator, { target: { value: 'assigned-port' } });
  fireEvent.change(card.getByLabelText('URL'), {
    target: { value: 'http://127.0.0.1/' },
  });
  fireEvent.click(card.getByRole('button', { name: 'Add endpoint' }));
  fireEvent.change(card.getAllByLabelText('Endpoint name')[1], {
    target: { value: 'health' },
  });
  fireEvent.change(card.getAllByLabelText('Discover endpoint from')[1], {
    target: { value: 'fixed' },
  });
  fireEvent.change(card.getAllByLabelText('URL')[1], {
    target: { value: 'http://localhost:9000/health' },
  });
  fireEvent.change(card.getByLabelText('Readiness endpoint'), {
    target: { value: 'health' },
  });
  expect(current()[0].services?.[1]).toMatchObject({
    name: 'Frontend',
    start: 'pnpm dev',
    cwd: 'frontend',
    portEnv: 'APP_PORT',
    description: 'UI checks',
    stop: 'pnpm stop',
    policy: 'manual',
    dependsOn: ['web/database'],
    env: { NODE_ENV: 'test' },
    readiness: { endpoint: 'health', attempts: 12, intervalMs: 500 },
  });
  expect(current()[0].services?.[1].endpoints).toHaveLength(2);
  fireEvent.click(card.getAllByRole('button', { name: 'Remove endpoint' })[0]);
  expect(current()[0].services?.[1].endpoints).toEqual([
    {
      name: 'health',
      locator: { kind: 'fixed', url: 'http://localhost:9000/health' },
    },
  ]);
  fireEvent.change(card.getByLabelText('Stop command (optional)'), {
    target: { value: '' },
  });
  expect(current()[0].services?.[1].stop).toBeUndefined();
  fireEvent.click(card.getByRole('button', { name: 'Remove service' }));
  expect(current()[0].services?.map((service) => service.id)).toEqual([
    'database',
  ]);
});

it('requires confirmation to test a saved command and reports both its run and request failure', async () => {
  const repo = repository();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const request = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === '/api/profile-command-tests' ? { runId: 'test/run' } : null,
        ),
        { headers: { 'x-rocky-version': '0.0.0' } },
      ),
  );
  vi.stubGlobal('fetch', request);
  render(
    <RepositorySettings
      repos={[repo]}
      savedRepos={[repo]}
      savedRevision="revision-1"
      profileId="test"
      disabled={false}
      mismatch={() => undefined}
      onChange={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test saved command' }));
  expect(
    request.mock.calls.some(([url]) => url === '/api/profile-command-tests'),
  ).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Test saved command' }));
  expect(
    (
      await screen.findByRole('link', { name: 'View test run and logs' })
    ).getAttribute('href'),
  ).toBe('/runs/test%2Frun');
  expect(request).toHaveBeenCalledWith(
    '/api/profile-command-tests',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        profileId: 'test',
        repositoryId: 'web',
        commandId: 'install',
        revision: 'revision-1',
      }),
    }),
  );
  request.mockImplementationOnce(
    async () =>
      new Response(JSON.stringify({ error: 'Revision changed' }), {
        status: 409,
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Test saved command' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Revision changed',
  );
  expect(
    (
      screen.getByRole('button', {
        name: 'Test saved command',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it('edits automation policy and Linear states as a single draft', () => {
  let current = automationSettings();
  function Editor() {
    const [value, setValue] = useState(current);
    current = value;
    return (
      <AutomationSettingsFields
        value={value}
        disabled={false}
        onChange={setValue}
      />
    );
  }
  render(<Editor />);
  fireEvent.click(
    screen.getByLabelText('Set up dependencies before implementation'),
  );
  for (const [label, value] of [
    ['Pull requests', 'all-changed'],
    ['Review and validation cycles', '4'],
    ['CI repair attempts', '5'],
    ['CI log lines', '50'],
    ['Maximum workflow transitions', '60'],
    ['started', 'Working'],
    ['review', 'Reviewing'],
    ['done', 'Complete'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(current).toMatchObject({
    workspaceSetup: false,
    pullRequests: 'all-changed',
    reviewCap: 4,
    ciCap: 5,
    ciLogLines: 50,
    maxTransitions: 60,
    states: { started: 'Working', review: 'Reviewing', done: 'Complete' },
  });
});

it('resolves service migration conflicts without duplicating an existing service and blocks migration errors', () => {
  const repo = repository();
  const chosen = { ...serviceRecipe('database'), start: 'docker compose up' };
  const migration = {
    repos: [repo],
    automation: automationSettings(),
    errors: [],
    conflicts: [
      {
        repository: 'web',
        id: 'legacy',
        kind: 'service' as const,
        choices: [{ source: 'Profile', value: chosen }],
      },
    ],
  };
  const apply = vi.fn();
  const view = render(
    <ConfigurationMigrationPanel
      migration={migration}
      disabled={false}
      onApply={apply}
    />,
  );
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '0' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Apply unified settings to draft' }),
  );
  expect(apply.mock.calls[0][0].repos[0].services).toEqual([chosen]);
  expect(repo.services).toEqual([serviceRecipe('database')]);
  view.rerender(
    <ConfigurationMigrationPanel
      migration={{ ...migration, errors: ['Missing repository'] }}
      disabled={false}
      onApply={apply}
    />,
  );
  expect(screen.getByRole('alert').textContent).toBe('Missing repository');
  expect(
    (
      screen.getByRole('button', {
        name: 'Apply unified settings to draft',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it('shows only suggestions for the active tab and retains edits across tab switches', async () => {
  const repo: WorkspaceRepository = {
    id: 'web',
    name: 'web',
    url: 'https://example.org/web',
    baseBranch: 'main',
    commands: [],
    services: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('/verify-environment')
              ? null
              : {
                  id: 'suggestions',
                  status: 'ready',
                  proposal: {
                    explanation: '',
                    commands: {},
                    ui: [],
                    catalog: {
                      commands: [commandRecipe('test', 'npm test')],
                      services: [
                        { ...serviceRecipe('dev'), start: 'npm start' },
                      ],
                    },
                  },
                },
          ),
        ),
    ),
  );
  const onChange = vi.fn();
  render(
    <RepositorySettings
      repos={[repo]}
      savedRepos={[repo]}
      profileId="test"
      disabled={false}
      mismatch={() => undefined}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Commands$/ }));
  await screen.findByDisplayValue('npm test');
  expect(screen.queryByDisplayValue('npm start')).toBeNull();
  fireEvent.change(screen.getByDisplayValue('npm test'), {
    target: { value: 'npm test -- --run' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Dev services' }));
  await screen.findByDisplayValue('npm start');
  expect(screen.queryByDisplayValue('npm test -- --run')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
  expect(onChange.mock.calls.at(-1)?.[0][0]).toMatchObject({
    commands: [],
    services: [{ start: 'npm start' }],
  });
  fireEvent.click(screen.getByRole('button', { name: /^Commands$/ }));
  await screen.findByDisplayValue('npm test -- --run');
});
it('requires an explicit migration conflict choice and keeps the chosen value in the draft', () => {
  const onApply = vi.fn();
  render(
    <ConfigurationMigrationPanel
      disabled={false}
      migration={{
        repos: [
          {
            id: 'web',
            name: 'web',
            url: 'https://example.org/web',
            baseBranch: 'main',
            commands: [],
            services: [],
          },
        ],
        automation: automationSettings(),
        errors: [],
        conflicts: [
          {
            repository: 'web',
            id: 'test',
            kind: 'command',
            choices: [
              { source: 'Flow', value: commandRecipe('test', 'npm test') },
              { source: 'Profile', value: commandRecipe('test', 'pnpm test') },
            ],
          },
        ],
      }}
      onApply={onApply}
    />,
  );
  expect(
    (
      screen.getByRole('button', {
        name: 'Apply unified settings to draft',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Apply unified settings to draft' }),
  );
  expect(onApply.mock.calls[0][0].repos[0].commands[0].command).toBe(
    'pnpm test',
  );
});
it('edits named commands and dynamic service endpoints while retaining repository identity', () => {
  let current: WorkspaceRepository[] = [];
  function Editor() {
    const [repos, setRepos] = useState<WorkspaceRepository[]>([
      {
        id: 'stable',
        name: 'web',
        url: 'https://example.org/web',
        baseBranch: 'main',
        commands: [
          { ...commandRecipe('test', 'npm test'), name: 'Unit tests' },
        ],
        services: [{ ...serviceRecipe('web'), start: 'npm start' }],
      },
    ]);
    current = repos;
    return (
      <RepositorySettings
        repos={repos}
        profileId="test"
        disabled={false}
        mismatch={() => undefined}
        onChange={setRepos}
      />
    );
  }
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('Folder name'), {
    target: { value: 'renamed' },
  });
  expect(current[0].id).toBe('stable');
  fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
  fireEvent.change(screen.getByLabelText('Shell command'), {
    target: { value: 'pnpm test:unit' },
  });
  expect(current[0].commands?.[0].id).toBe('test');
  fireEvent.click(screen.getByRole('button', { name: 'Dev services' }));
  fireEvent.change(screen.getByLabelText('Discover endpoint from'), {
    target: { value: 'json-file' },
  });
  fireEvent.change(
    screen.getByLabelText('JSON file (relative to repository)'),
    { target: { value: '.runtime/listener.json' } },
  );
  expect(current[0].services?.[0].endpoints[0].locator).toEqual({
    kind: 'json-file',
    path: '.runtime/listener.json',
    pointer: '/port',
  });
  expect(
    screen.getByText('Save repository changes before using AI discovery.'),
  ).toBeTruthy();
});
