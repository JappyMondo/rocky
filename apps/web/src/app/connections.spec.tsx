import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ConnectionsView,
  ConnectionLogin,
  McpDefinition,
} from '@rocky/local-contracts';
import { Connections } from './connections.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const mismatch = vi.fn();
const original = (): ConnectionsView => ({
  linear: {
    state: 'login-required',
    message: 'Reauthenticate Linear to continue',
  },
  profiles: [
    {
      id: 'demo',
      revision: 'r1',
      servers: [
        {
          name: 'remote',
          allowed: true,
          definition: {
            type: 'http',
            url: 'https://mcp.example',
            headers: { Authorization: null },
          },
          auth: { state: 'saved', message: 'OAuth credentials saved' },
        },
        {
          name: 'local',
          allowed: false,
          definition: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { TOKEN: null },
          },
          auth: { state: 'not-configured', message: 'Local process' },
        },
      ],
    },
    { id: 'empty', revision: 'r2', servers: [] },
  ],
});
function fixture(
  overrides: {
    data?: ConnectionsView;
    handle?: (path: string, init?: RequestInit) => unknown;
  } = {},
) {
  const data = overrides.data ?? original();
  const calls: Array<{
    path: string;
    init?: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      init,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const custom = overrides.handle?.(path, init);
    if (custom instanceof Response) return custom;
    let result: unknown = custom;
    if (result === undefined) {
      if (path === '/api/connections') result = data;
      else if (path.endsWith('/linear/check'))
        result = { state: 'connected', message: 'Linear verified' };
      else if (path.endsWith('/check'))
        result = {
          state: 'connected',
          message: 'Connected · 1 tools available',
          tools: ['search'],
        };
      else if (!path.includes('/logins/') && path.endsWith('/login'))
        result = {
          id: 'login',
          status: 'waiting',
          authorizationUrl: 'https://auth.example/authorize',
        };
      else if (path.includes('/logins/'))
        result = {
          id: 'login',
          status: init?.method === 'DELETE' ? 'cancelled' : 'success',
          message: 'Authentication saved',
        };
      else if (path.endsWith('/credentials')) result = { ok: true };
      else {
        const parts = path.split('/');
        const profile = data.profiles.find((p) => p.id === parts[4])!;
        const name = parts[6];
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          profile.servers = profile.servers.filter(
            (server) => server.name !== name,
          );
          profile.servers.push({
            name,
            definition: body.definition as McpDefinition,
            allowed: body.allowed,
            auth: { state: 'not-configured', message: 'No login' },
          });
        } else
          profile.servers = profile.servers.filter(
            (server) => server.name !== name,
          );
        profile.revision = 'updated';
        result = profile;
      }
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-rocky-version': '0.0.0',
      },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { data, calls, fetch };
}
async function mount() {
  render(<Connections disabled={false} mismatch={mismatch} />);
  await screen.findByLabelText('Profile for MCP servers');
}

it('creates and edits a remote server while keeping saved header values opaque', async () => {
  const f = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Add MCP server' }));
  fireEvent.change(dialog.getByLabelText('Server name'), {
    target: { value: 'new' },
  });
  fireEvent.change(dialog.getByLabelText('Server URL'), {
    target: { value: 'https://new.example/mcp' },
  });
  fireEvent.change(dialog.getByLabelText('Transport'), {
    target: { value: 'sse' },
  });
  fireEvent.change(dialog.getByLabelText('Server URL'), {
    target: { value: 'https://new.example/sse' },
  });
  fireEvent.change(dialog.getByLabelText('New Headers name'), {
    target: { value: 'Authorization' },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Add entry' }));
  fireEvent.change(dialog.getByLabelText('Headers: Authorization'), {
    target: { value: 'Bearer secret' },
  });
  fireEvent.click(
    dialog.getByLabelText('Allow this server for the profile’s agents'),
  );
  fireEvent.click(dialog.getByRole('button', { name: 'Save MCP server' }));
  await screen.findByRole('button', { name: 'Edit new' });
  expect(
    f.calls.find((call) => call.init?.method === 'PUT')?.body,
  ).toMatchObject({
    revision: 'r1',
    allowed: true,
    definition: { type: 'sse', headers: { Authorization: 'Bearer secret' } },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Edit remote' }));
  const edit = within(screen.getByRole('dialog', { name: 'Edit MCP server' }));
  expect(
    (edit.getByLabelText('Server name') as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (edit.getByLabelText('Headers: Authorization') as HTMLInputElement).value,
  ).toBe('');
  fireEvent.change(edit.getByLabelText('Server URL'), {
    target: { value: 'https://mcp.example/v2' },
  });
  fireEvent.click(edit.getByRole('button', { name: 'Save MCP server' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    f.calls.filter((call) => call.init?.method === 'PUT')[1].body,
  ).toMatchObject({ definition: { headers: { Authorization: null } } });
});

it('edits a local server, validates arguments and manages secret entries', async () => {
  const f = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Edit local' }));
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Command'), {
    target: { value: 'npx' },
  });
  fireEvent.change(dialog.getByLabelText('Arguments (JSON array)'), {
    target: { value: 'invalid' },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Save MCP server' }));
  await dialog.findByRole('alert');
  expect(f.calls.some((call) => call.init?.method === 'PUT')).toBe(false);
  fireEvent.change(dialog.getByLabelText('Arguments (JSON array)'), {
    target: { value: '["server"]' },
  });
  fireEvent.click(
    dialog.getByRole('button', { name: 'Remove Environment variables: TOKEN' }),
  );
  fireEvent.change(dialog.getByLabelText('New Environment variables name'), {
    target: { value: 'KEY' },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Add entry' }));
  fireEvent.change(dialog.getByLabelText('Environment variables: KEY'), {
    target: { value: 'value' },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Save MCP server' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    f.calls.find((call) => call.init?.method === 'PUT')?.body,
  ).toMatchObject({
    definition: { command: 'npx', args: ['server'], env: { KEY: 'value' } },
  });
});

it('switches profiles and creates a local definition from the transport selector', async () => {
  fixture();
  await mount();
  fireEvent.change(screen.getByLabelText('Profile for MCP servers'), {
    target: { value: 'empty' },
  });
  expect(screen.getByText(/No MCP servers in this profile/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
  fireEvent.change(screen.getByLabelText('Transport'), {
    target: { value: 'stdio' },
  });
  expect(screen.getByLabelText('Command')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps edits open on a conflicting save and lets the user cancel', async () => {
  fixture({
    handle: (_path, init) =>
      init?.method === 'PUT'
        ? new Response(JSON.stringify({ error: 'Profile changed' }), {
            status: 409,
          })
        : undefined,
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Edit remote' }));
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Save MCP server' }));
  expect((await dialog.findByRole('alert')).textContent).toContain(
    'Profile changed',
  );
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('confirms removal and shared credential forgetting, preserving cancelled operations', async () => {
  const f = fixture();
  await mount();
  const confirm = vi
    .spyOn(window, 'confirm')
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove remote' }));
  expect(f.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Forget login' }));
  await waitFor(() =>
    expect(f.calls.some((call) => call.path.endsWith('/credentials'))).toBe(
      true,
    ),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Remove remote',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove remote' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Edit remote' })).toBeNull(),
  );
  expect(confirm).toHaveBeenCalledTimes(3);
});

it('checks Linear and lists the server’s tools without invoking them', async () => {
  fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Test Linear access' }));
  await screen.findByText('Linear verified');
  fireEvent.click(screen.getByRole('button', { name: 'Test local' }));
  await screen.findByText('Connected · 1 tools available');
  fireEvent.click(screen.getByText('Available tools (1)'));
  expect(screen.getByText('search')).toBeTruthy();
});

it('accepts advanced MCP OAuth settings and polls until authentication completes', async () => {
  const f = fixture();
  await mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Reauthenticate remote' }),
  );
  fireEvent.click(screen.getByText('Advanced OAuth settings'));
  fireEvent.change(screen.getByLabelText('OAuth client ID'), {
    target: { value: 'client' },
  });
  fireEvent.change(screen.getByLabelText('OAuth client secret'), {
    target: { value: 'private' },
  });
  fireEvent.change(screen.getByLabelText('Callback port'), {
    target: { value: '8765' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start login' }));
  expect(
    (
      await screen.findByRole('link', { name: 'Continue to authorization' })
    ).getAttribute('href'),
  ).toBe('https://auth.example/authorize');
  await screen.findByText('Authentication saved', {}, { timeout: 3000 });
  expect(
    f.calls.find((call) => call.path.endsWith('/mcp/remote/login'))?.body,
  ).toEqual({
    clientId: 'client',
    clientSecret: 'private',
    callbackPort: 8765,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('starts Linear reauthentication and cancels its callback wait from the dialog', async () => {
  const f = fixture({
    handle: (path, init) =>
      path.includes('/logins/') && init?.method !== 'DELETE'
        ? { id: 'login', status: 'waiting' }
        : undefined,
  });
  await mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Reauthenticate Linear' }),
  );
  await screen.findByRole('dialog', { name: 'Authentication progress' });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    f.calls.some(
      (call) =>
        call.path === '/api/connections/logins/login' &&
        call.init?.method === 'DELETE',
    ),
  ).toBe(true);
});

it.each(['failed', 'lost'] as const)(
  'shows %s login outcomes without leaving a permanent spinner',
  async (outcome) => {
    fixture({
      handle: (path, init) =>
        path.includes('/logins/') && init?.method !== 'DELETE'
          ? outcome === 'lost'
            ? new Response('{}', { status: 404 })
            : ({
                id: 'login',
                status: 'failed',
                message: 'Provider denied access',
              } satisfies ConnectionLogin)
          : undefined,
    });
    await mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Reauthenticate Linear' }),
    );
    await screen.findByText(
      outcome === 'lost' ? /Login status was lost/ : 'Provider denied access',
    );
    expect(
      screen.queryByRole('link', { name: 'Continue to authorization' }),
    ).toBeNull();
  },
);

it('recovers a failed load and explains when no profiles or Linear app exist', async () => {
  let broken = true;
  fixture({
    data: {
      profiles: [],
      linear: { state: 'not-configured', message: 'Complete setup' },
    },
    handle: () => (broken ? new Response('{}', { status: 500 }) : undefined),
  });
  render(<Connections disabled={false} mismatch={mismatch} />);
  await screen.findByRole('alert');
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Reload connections' }));
  await screen.findByText('Create a profile before adding MCP servers.');
  expect(
    (
      screen.getByRole('button', {
        name: 'Reauthenticate Linear',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it('lets the user cancel login options and remove a header without changing the server', async () => {
  fixture();
  await mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Reauthenticate remote' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit remote' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove Headers: Authorization' }),
  );
  expect(screen.queryByLabelText('Headers: Authorization')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
});
