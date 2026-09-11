import { randomUUID } from 'node:crypto';
import type {
  ConnectionsView,
  ConnectionLogin,
  ConnectionStatus,
  ConnectionCheck,
} from '@rocky/local-contracts';
import { z } from 'zod';
import type { RockyPaths } from '../config/paths.js';
import {
  readCredentials,
  readInstanceConfig,
  updateCredentials,
} from '../config/store.js';
import { readRepositoryProfile, profileMcpConfig } from '../config/profiles.js';
import {
  loginMcpServer,
  expandMcpConfig,
  resolveMcpServers,
  McpAuthError,
} from '../mcp/index.js';
import { inspectMcp } from '../mcp/connection.js';
import { createInstanceLinearClient } from '../linear/instance-client.js';
import { LinearNotConfiguredError } from '../linear/client.js';
import {
  authorizeUrl,
  exchangeCode,
  LinearOAuthError,
} from '../linear/oauth.js';
import type { OAuthCallbackBroker } from '../linear/callback.js';
import { withAbort } from '../abort.js';
import { LocalProfiles } from './profiles.js';
import { LocalApiError } from './settings.js';

type Login = {
  view: ConnectionLogin;
  target: string;
  abort: AbortController;
  done: Promise<void>;
};
const loginOptions = z
  .object({
    clientId: z.string().min(1).max(16000).optional(),
    clientSecret: z.string().min(1).max(16000).optional(),
    callbackPort: z.number().int().min(0).max(65535).optional(),
  })
  .strict();
const active = (login: Login) =>
  ['starting', 'waiting'].includes(login.view.status);

export class LocalConnections {
  private readonly profiles: LocalProfiles;
  private readonly logins = new Map<string, Login>();
  private linearHealth?: { at: number; value: ConnectionStatus };
  private checking?: Promise<ConnectionStatus>;
  constructor(
    private readonly paths: RockyPaths,
    private readonly options: {
      oauth?: OAuthCallbackBroker;
      fetch?: typeof fetch;
      loginMcp?: typeof loginMcpServer;
      inspectMcp?: typeof inspectMcp;
    } = {},
  ) {
    this.profiles = new LocalProfiles(paths);
  }

  async read(): Promise<ConnectionsView> {
    const credentials = await readCredentials(this.paths);
    const profiles = await Promise.all(
      (await this.profiles.list()).map(async (profile) => {
        const view = await this.profiles.mcp(profile.id);
        const { config } = await this.selected(profile.id);
        for (const server of view.servers) {
          const definition = config.mcpServers[server.name];
          if (definition.type === 'stdio') continue;
          if (
            Object.keys(definition.headers ?? {}).some(
              (name) => name.toLowerCase() === 'authorization',
            )
          )
            server.auth = {
              state: 'saved',
              message: 'Authorization header configured',
            };
          else {
            try {
              const expanded = await this.selected(profile.id, server.name);
              const remote = expanded.config.mcpServers[server.name];
              if (
                remote.type !== 'stdio' &&
                credentials.mcp[new URL(remote.url).href]
              )
                server.auth = {
                  state: 'saved',
                  message: 'OAuth credentials saved; test to verify access',
                };
            } catch {
              server.auth = {
                state: 'error',
                message:
                  'Configure the environment variables used by this server',
              };
            }
          }
        }
        return view;
      }),
    );
    return { profiles, linear: await this.checkLinear() };
  }

  async checkLinear(force = false): Promise<ConnectionStatus> {
    if (
      !force &&
      this.linearHealth &&
      Date.now() - this.linearHealth.at < 30_000
    )
      return this.linearHealth.value;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let value: ConnectionStatus;
      try {
        await createInstanceLinearClient(this.paths, {
          fetch: this.options.fetch,
          signal: AbortSignal.timeout(15_000),
        }).viewer();
        value = { state: 'connected', message: 'Linear API access verified' };
      } catch (error) {
        const auth = (await readCredentials(this.paths)).linear;
        value =
          error instanceof LinearNotConfiguredError &&
          (!auth?.clientId || !auth.clientSecret || !auth.redirectUri)
            ? {
                state: 'not-configured',
                message: 'Complete Rocky setup to configure the Linear app',
              }
            : error instanceof LinearNotConfiguredError ||
                (error instanceof LinearOAuthError &&
                  error.status &&
                  error.status < 500)
              ? {
                  state: 'login-required',
                  message:
                    'Linear authorization expired or was revoked. Sign in again.',
                }
              : {
                  state: 'error',
                  message:
                    'Could not verify Linear API access. Check connectivity or reauthenticate.',
                };
      }
      this.linearHealth = { at: Date.now(), value };
      return value;
    })();
    try {
      return await this.checking;
    } finally {
      this.checking = undefined;
    }
  }

  private async selected(profileId: string, name?: string) {
    const profile = await readRepositoryProfile(this.paths, profileId);
    const raw = profileMcpConfig(profile, this.paths.profile(profileId));
    const credentials = await readCredentials(this.paths);
    const instance = await readInstanceConfig(this.paths);
    const repo =
      instance.repos.find((entry) => entry.profile === profileId)?.name ??
      profileId;
    const env = {
      ...process.env,
      ...profile.settings.env,
      ...Object.fromEntries(
        profile.settings.secretEnv.flatMap((key) =>
          credentials.repos[repo]?.[key] === undefined
            ? []
            : [[key, credentials.repos[repo][key]]],
        ),
      ),
    };
    if (!name) return { config: raw, env };
    if (!Object.hasOwn(raw.mcpServers, name))
      throw new LocalApiError(404, 'unknown-mcp', 'MCP server not found.');
    const config = expandMcpConfig(
      { ...raw, mcpServers: { [name]: raw.mcpServers[name] } },
      { env },
    );
    return { config, env };
  }

  private start(
    target: string,
    work: (login: Login) => Promise<void>,
  ): ConnectionLogin {
    const existing = [...this.logins.values()].find(
      (login) => login.target === target && active(login),
    );
    if (existing) return { ...existing.view };
    if (this.logins.size >= 50) {
      for (const [id, login] of this.logins)
        if (!active(login)) this.logins.delete(id);
      if (this.logins.size >= 50)
        throw new LocalApiError(
          429,
          'too-many-logins',
          'Finish or cancel an existing login first.',
        );
    }
    const login: Login = {
      target,
      view: { id: randomUUID(), status: 'starting' },
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.logins.set(login.view.id, login);
    login.done = Promise.resolve()
      .then(() => work(login))
      .then(() => {
        login.view = {
          id: login.view.id,
          status: 'success',
          message: 'Authentication saved',
        };
      })
      .catch((error) => {
        login.view = {
          id: login.view.id,
          status: login.abort.signal.aborted ? 'cancelled' : 'failed',
          message:
            error instanceof McpAuthError
              ? error.message
              : 'Authentication did not complete. Retry and approve access in the browser; check the app settings if it persists.',
        };
      });
    return { ...login.view };
  }

  startMcp(profileId: string, name: string, input: unknown): ConnectionLogin {
    const parsed = loginOptions.safeParse(input ?? {});
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-login',
        'Enter valid OAuth client settings.',
      );
    return this.start(`mcp:${profileId}:${name}`, async (login) => {
      const { config, env } = await this.selected(profileId, name);
      await (this.options.loginMcp ?? loginMcpServer)(config, name, {
        ...parsed.data,
        paths: this.paths,
        env,
        fetch: this.options.fetch,
        signal: login.abort.signal,
        openBrowser: async (url) => {
          login.view = {
            id: login.view.id,
            status: 'waiting',
            authorizationUrl: url.href,
          };
        },
      });
    });
  }

  startLinear(): ConnectionLogin {
    if (!this.options.oauth)
      throw new LocalApiError(
        503,
        'login-unavailable',
        'The Linear callback is unavailable. Restart Rocky.',
      );
    const broker = this.options.oauth;
    return this.start('linear', async (login) => {
      const auth = (await readCredentials(this.paths)).linear;
      if (!auth?.clientId || !auth.clientSecret || !auth.redirectUri)
        throw new Error('Linear app is not configured');
      const state = randomUUID();
      const signal = AbortSignal.any([
        login.abort.signal,
        AbortSignal.timeout(120_000),
      ]);
      const code = broker.expect(state);
      void code.catch(() => undefined);
      login.view = {
        id: login.view.id,
        status: 'waiting',
        authorizationUrl: authorizeUrl({
          clientId: auth.clientId,
          redirectUri: auth.redirectUri,
          state,
        }),
      };
      try {
        const received = await withAbort(signal, () => code);
        await updateCredentials(
          this.paths,
          async (current) => {
            if (
              current.linear?.clientId !== auth.clientId ||
              current.linear?.clientSecret !== auth.clientSecret
            )
              throw new Error('Linear app configuration changed');
            const tokens = await exchangeCode(
              {
                clientId: auth.clientId!,
                clientSecret: auth.clientSecret!,
                redirectUri: auth.redirectUri!,
                code: received,
              },
              {
                fetch: (input, init) =>
                  (this.options.fetch ?? fetch)(input, {
                    ...init,
                    signal,
                    redirect: 'error',
                  }),
              },
            );
            return { ...current, linear: { ...current.linear, ...tokens } };
          },
          { signal },
        );
        this.linearHealth = undefined;
      } finally {
        broker.cancel(state);
      }
    });
  }

  login(id: string): ConnectionLogin {
    const login = this.logins.get(id);
    if (!login)
      throw new LocalApiError(
        404,
        'unknown-login',
        'Login expired or Rocky restarted. Start a new login.',
      );
    return { ...login.view };
  }
  async cancel(id: string): Promise<ConnectionLogin> {
    const login = this.logins.get(id);
    if (!login) return this.login(id);
    if (active(login)) {
      login.abort.abort();
      await login.done;
    }
    return this.login(id);
  }
  private async cancelMcp(profileId: string, name: string, resource?: string) {
    await Promise.all(
      [...this.logins.values()]
        .filter((login) => login.target.startsWith('mcp:') && active(login))
        .map(async (login) => {
          if (login.target === `mcp:${profileId}:${name}`) {
            await this.cancel(login.view.id);
            return;
          }
          if (!resource) return;
          const [, profile, serverName] = login.target.split(':');
          try {
            const { config } = await this.selected(profile, serverName);
            const server = config.mcpServers[serverName];
            if (
              server.type !== 'stdio' &&
              new URL(server.url).href === resource
            )
              await this.cancel(login.view.id);
          } catch {
            /* A removed profile has no credentials to forget here. */
          }
        }),
    );
  }
  async save(profileId: string, name: string, input: unknown, remove = false) {
    await this.cancelMcp(profileId, name);
    return this.profiles.saveMcp(profileId, name, input, remove);
  }
  async forget(profileId: string, name: string): Promise<void> {
    const { config } = await this.selected(profileId, name);
    const server = config.mcpServers[name];
    if (server.type === 'stdio')
      throw new LocalApiError(
        400,
        'stdio-auth',
        'Local servers have no saved OAuth login.',
      );
    await this.cancelMcp(profileId, name, new URL(server.url).href);
    await updateCredentials(this.paths, (current) => {
      const mcp = { ...current.mcp };
      delete mcp[new URL(server.url).href];
      return { ...current, mcp };
    });
  }
  async check(profileId: string, name: string): Promise<ConnectionCheck> {
    try {
      const { config, env } = await this.selected(profileId, name);
      const signal = AbortSignal.timeout(15_000);
      const [server] = await resolveMcpServers(config, [name], {
        paths: this.paths,
        signal,
        fetch: this.options.fetch,
      });
      const tools = await (this.options.inspectMcp ?? inspectMcp)(
        server,
        signal,
        env,
      );
      return {
        state: 'connected',
        message: `Connected · ${tools.length} tools available`,
        tools,
      };
    } catch (error) {
      return {
        state: error instanceof McpAuthError ? 'login-required' : 'error',
        message:
          'Connection failed. Check the definition, required environment values and login, then test again.',
      };
    }
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.logins.values()]
        .filter(active)
        .map((login) => this.cancel(login.view.id)),
    );
  }
}
