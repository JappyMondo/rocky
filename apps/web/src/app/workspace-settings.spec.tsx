import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  automationSettings,
  commandRecipe,
  serviceRecipe,
  type WorkspaceRepository,
} from '@rocky/local-contracts';
import {
  ConfigurationMigrationPanel,
  RepositorySettings,
} from './workspace-settings.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
