import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecipeDiscoveryPanel } from './recipe-discovery.js';
import { commandRecipe, serviceRecipe } from '@rocky/local-contracts';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('edits suggestions directly without checkboxes or explanation text', async () => {
  const job = {
    id: 'job',
    repository: 'web',
    status: 'ready',
    proposal: {
      commands: { install: 'npm ci', test: 'npm test' },
      ui: [],
      explanation: 'Found in package.json',
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(job), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const onApply = vi.fn();
  render(
    <RecipeDiscoveryPanel
      profileId="app"
      repository="web"
      disabled={false}
      recipes={{ commands: { build: 'npm run build' } }}
      mismatch={() => undefined}
      onApply={onApply}
    />,
  );
  await screen.findByDisplayValue('npm test');
  expect(screen.queryByText('Found in package.json')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove install' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Suggestion 1 command' }),
    { target: { value: 'npm test -- --run' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
  expect(onApply).toHaveBeenCalledWith({
    commands: { build: 'npm run build', test: 'npm test -- --run' },
    ui: [],
  });
  expect(
    fetch.mock.calls.every((call) => !call[1] || call[1].method !== 'PUT'),
  ).toBe(true);
});
it('applies edited catalog fields and endpoints while preserving runtime metadata and prerequisites', async () => {
  const install = commandRecipe('install', 'npm ci');
  const test = {
    ...commandRecipe('test', 'npm test'),
    dependsOn: ['web/install'],
  };
  const service = { ...serviceRecipe('web'), start: 'npm start' };
  const proposal = {
    commands: {},
    ui: [],
    explanation: 'Long explanation',
    catalog: { commands: [install, test], services: [service] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'catalog', status: 'ready', proposal }),
        ),
    ),
  );
  const onApplyCatalog = vi.fn();
  render(
    <RecipeDiscoveryPanel
      profileId="app"
      repository="web"
      disabled={false}
      mismatch={() => undefined}
      onApply={vi.fn()}
      onApplyCatalog={onApplyCatalog}
    />,
  );
  await screen.findByDisplayValue('npm ci');
  expect(
    screen
      .getByRole('button', { name: 'Remove install' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Suggestion 2 name'), {
    target: { value: 'Unit tests' },
  });
  fireEvent.change(screen.getByLabelText('Suggestion 2 directory'), {
    target: { value: 'frontend' },
  });
  fireEvent.change(screen.getByLabelText('Suggestion 2 command'), {
    target: { value: 'nvm use && npm test' },
  });
  fireEvent.change(screen.getByLabelText('web web url'), {
    target: { value: 'http://localhost/app' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
  expect(onApplyCatalog).toHaveBeenCalledWith({
    commands: [
      install,
      {
        ...test,
        name: 'Unit tests',
        cwd: 'frontend',
        command: 'nvm use && npm test',
      },
    ],
    services: [
      {
        ...service,
        endpoints: [
          {
            name: 'web',
            locator: { kind: 'assigned-port', url: 'http://localhost/app' },
          },
        ],
      },
    ],
  });
  expect(screen.queryByRole('button', { name: 'Apply to draft' })).toBeNull();
});
it('starts discovery and exposes cancellation while running', async () => {
  let job: { id: string; status: string } | null = null;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === 'POST') job = { id: 'job', status: 'running' };
    if (init?.method === 'DELETE') job = { id: 'job', status: 'cancelled' };
    return new Response(JSON.stringify(job), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <RecipeDiscoveryPanel
      profileId="app"
      repository="web"
      disabled={false}
      mismatch={() => undefined}
      onApply={vi.fn()}
    />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /Discover with AI/ }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel discovery' }),
  );
  await screen.findByText('Discovery cancelled.');
});
