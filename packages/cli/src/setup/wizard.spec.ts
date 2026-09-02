/**
 * AC1: a fresh machine reaches a working install through `rocky setup` alone,
 * including the printed manifest hand-off and the final self-ping.
 * AC2: the wizard cannot be driven into creating the app before the public URL
 * exists.
 *
 * The wizard is driven through a scripted `Prompter`, so the whole dialogue is
 * asserted — including the order of it, which is the thing NG-578 says the
 * command exists for.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rockyPaths, startDaemon } from '@rocky/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prompter } from './prompter.js';
import { runSetup, type SetupResult } from './wizard.js';

const PUBLIC_URL = 'https://rocky-janjaap.example.com';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rocky-setup-'));
});

afterEach(() => {
  // The wizard closes the daemon it started itself, in a `finally`.
  rmSync(home, { recursive: true, force: true });
});

/** A prompter that answers from a script and records everything said. */
function scripted(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];

  const prompter: Prompter = {
    say: (line) => said.push(line),
    ask: async (question) => {
      asked.push(question);
      return queue.shift() ?? '';
    },
    askSecret: async (question) => {
      asked.push(question);
      return queue.shift() ?? '';
    },
    waitFor: async (instruction) => {
      asked.push(instruction);
      queue.shift();
    },
  };

  return { prompter, said, asked, transcript: () => said.join('\n') };
}

/**
 * A whole successful run. The daemon the wizard starts to serve its own OAuth
 * callback and self-ping is a real one on a free port, and "the public URL"
 * resolves to it — which is what a working tunnel amounts to.
 */
async function runHappyPath(
  answers: string[],
  overrides: Record<string, unknown> = {},
): Promise<{
  result: SetupResult;
  said: string[];
  asked: string[];
  transcript: () => string;
}> {
  const harness = scripted(answers);

  const tokenFetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'the-access-token',
          refresh_token: 'the-refresh-token',
          expires_in: 86_400,
          scope: 'read,write',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

  const result = await runSetup({
    prompter: harness.prompter,
    paths: rockyPaths(home),
    port: 0,
    // The wizard hands the code back through the daemon's own callback route,
    // so the test plays the part of the browser Linear redirects.
    onAuthorizeUrl: async (url, running) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      await fetch(
        `${running.url}/api/linear/oauth/callback?code=the-code&state=${state}`,
      );
    },
    fetch: tokenFetch as unknown as typeof fetch,
    // "Through the public URL" is the daemon's own address in a test.
    resolvePublicUrl: (_publicUrl, running) => running.url,
    ...overrides,
  });

  return { result, ...harness };
}

describe('the order the wizard enforces', () => {
  it('asks for the public URL before it prints anything to hand to the admin', async () => {
    const { asked, transcript } = await runHappyPath([
      'Jan Jaap',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    const urlQuestion = asked.findIndex((q) => /public URL/i.test(q));
    const clientIdQuestion = asked.findIndex((q) => /client id/i.test(q));

    expect(urlQuestion).toBeGreaterThanOrEqual(0);
    expect(urlQuestion).toBeLessThan(clientIdQuestion);
    expect(transcript()).toContain(
      'https://linear.app/settings/api/applications/new',
    );
  });

  it('re-asks until the public URL is one Linear could actually POST to', async () => {
    const { asked, said } = await runHappyPath([
      'Jan Jaap',
      // Every one of these is a way a setup silently dies later.
      '',
      'http://rocky.example.com',
      'https://localhost:7625',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    expect(asked.filter((q) => /public URL/i.test(q))).toHaveLength(4);
    const complaints = said.join('\n');
    expect(complaints).toMatch(/https/i);
    expect(complaints).toMatch(/reach/i);
  });

  it('never prints a manifest URL on a run that gives up before the endpoint', async () => {
    const harness = scripted(['Jan Jaap', '', '', '', '', '', '', '', '']);

    await expect(
      runSetup({
        prompter: harness.prompter,
        paths: rockyPaths(home),
        port: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/public URL/i);

    // The one assertion AC2 is really about: no manifest, so no app.
    expect(harness.said.join('\n')).not.toContain('manifest=');
    expect(harness.said.join('\n')).not.toContain('applications/new');
  });
});

describe('a port that is already taken', () => {
  it('names the running daemon rather than reporting EADDRINUSE', async () => {
    const occupant = await startDaemon({ port: 0, webRoot: false });

    try {
      const harness = scripted(['Jan Jaap', PUBLIC_URL]);

      await expect(
        runSetup({
          prompter: harness.prompter,
          paths: rockyPaths(home),
          port: occupant.port,
        }),
      ).rejects.toThrow(/already in use.*rocky stop/s);
    } finally {
      await occupant.close();
    }
  });

  it('passes any other bind failure through untouched', async () => {
    const harness = scripted(['Jan Jaap', PUBLIC_URL]);

    await expect(
      runSetup({
        prompter: harness.prompter,
        paths: rockyPaths(home),
        port: 0,
        // TEST-NET-3: a routable-looking address no interface holds, so the
        // bind fails for a reason that is not a port clash.
        host: '203.0.113.1',
      }),
    ).rejects.toThrow(/EADDRNOTAVAIL|EINVAL/);
  });
});

describe('what a completed run leaves behind', () => {
  it('writes the endpoint to config.json and the secrets to credentials.json', async () => {
    const { result } = await runHappyPath([
      'Jan Jaap',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    expect(result.ok).toBe(true);

    const paths = rockyPaths(home);
    const config = JSON.parse(readFileSync(paths.configFile, 'utf8')) as {
      publicUrl?: string;
      linear?: unknown;
    };
    expect(config.publicUrl).toBe(PUBLIC_URL);
    // No secrets in the file the web UI shows and a human may hand-edit.
    expect(JSON.stringify(config)).not.toContain('client-secret-1');
    expect(JSON.stringify(config)).not.toContain('the-access-token');

    const credentials = JSON.parse(
      readFileSync(paths.credentialsFile, 'utf8'),
    ) as { linear?: Record<string, unknown> };
    expect(credentials.linear).toMatchObject({
      clientId: 'client-id-1',
      clientSecret: 'client-secret-1',
      webhookSecret: 'webhook-secret-1',
      accessToken: 'the-access-token',
      refreshToken: 'the-refresh-token',
    });
    expect(credentials.linear?.expiresAt).toEqual(expect.any(Number));
  });

  it('leaves credentials.json readable only by its owner', async () => {
    await runHappyPath([
      'Jan Jaap',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    const mode = statSync(rockyPaths(home).credentialsFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('verifies with a self-ping through the public URL and says so', async () => {
    const { result, transcript } = await runHappyPath([
      'Jan Jaap',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    expect(result.endpoint.ok).toBe(true);
    expect(transcript()).toMatch(/reached Rocky|self-ping|reachable/i);
  });

  it('ends by offering `rocky start`', async () => {
    const { transcript } = await runHappyPath([
      'Jan Jaap',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    expect(transcript()).toContain('rocky start');
  });
});

describe('a self-ping that fails at the end', () => {
  it('still keeps the credentials, and says what to fix', async () => {
    const { result, transcript } = await runHappyPath(
      [
        'Jan Jaap',
        PUBLIC_URL,
        '',
        'client-id-1',
        'client-secret-1',
        'webhook-secret-1',
        '',
      ],
      // The tunnel is not up: the public URL resolves to nothing listening.
      { resolvePublicUrl: () => 'http://127.0.0.1:1' },
    );

    expect(result.ok).toBe(false);
    expect(result.endpoint.ok).toBe(false);
    // Throwing the setup away over a tunnel that is not up yet would mean
    // pasting the client secret again for a fault outside Rocky.
    const credentials = JSON.parse(
      readFileSync(rockyPaths(home).credentialsFile, 'utf8'),
    ) as { linear?: Record<string, unknown> };
    expect(credentials.linear?.accessToken).toBe('the-access-token');
    expect(transcript()).toMatch(/docs\/public-endpoint\.md/);
  });
});

describe('the manifest the admin is handed', () => {
  it('carries the webhook on the public URL and the callback on the daemon', async () => {
    const { said } = await runHappyPath([
      'Jan Jaap',
      PUBLIC_URL,
      '',
      'client-id-1',
      'client-secret-1',
      'webhook-secret-1',
      '',
    ]);

    const printed = said.find((line) => line.includes('applications/new'));
    const manifest = JSON.parse(
      new URL(printed as string).searchParams.get('manifest') ?? '',
    ) as {
      webhook: { url: string };
      oauth: { client_name: string; redirect_uris: string[] };
    };

    expect(manifest.webhook.url).toBe(`${PUBLIC_URL}/api/linear/webhook`);
    expect(manifest.oauth.client_name).toBe('Rocky (Jan Jaap)');
    expect(manifest.oauth.redirect_uris[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/linear\/oauth\/callback$/,
    );
  });
});
