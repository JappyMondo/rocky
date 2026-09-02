/**
 * `rocky setup` — the interactive first-run wizard (NG-578, NG-600).
 *
 * The order is the point. A Linear webhook URL is fixed on the OAuth *client*
 * when the app is created, and the only programmatic way to move it afterwards
 * is an ALPHA mutation that needs a managing app — which NG-578 rejected. So a
 * developer who creates the app before they have a public URL has to delete it
 * and start again, having already spent a workspace admin's attention. This
 * command exists to make that impossible: it asks for the endpoint first, and
 * the manifest cannot even be built without one.
 *
 * The admin handshake stays human. Rocky prints a manifest URL and waits;
 * nothing here automates a workspace admin's approval, because `actor=app`
 * installs require one and no API removes that.
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  assertPublicUrl,
  authorizeUrl,
  buildManifest,
  createEndpointMonitor,
  exchangeCode,
  manifestUrl,
  oauthRedirectUri,
  readCredentials,
  readInstanceConfig,
  rockyPaths,
  startDaemon,
  writeCredentials,
  writeInstanceConfig,
  type EndpointHealth,
  type RockyPaths,
  type RunningDaemon,
} from '@rocky/daemon';

import type { Prompter } from './prompter.js';

/** How many times a question is re-asked before the wizard gives up. */
const DEFAULT_MAX_ATTEMPTS = 5;

export interface SetupOptions {
  prompter: Prompter;
  paths?: RockyPaths;
  host?: string;
  port?: number;
  maxAttempts?: number;
  /**
   * What to do with the authorize URL. In production the human opens it; a test
   * plays the browser Linear redirects back to the daemon's callback.
   */
  onAuthorizeUrl?(url: string, daemon: RunningDaemon): Promise<void>;
  /** Injected for the OAuth token exchange only — never for the self-ping. */
  fetch?: typeof fetch;
  /**
   * What the self-ping should actually dial. Production dials the public URL
   * itself; a test points it at the daemon it just started, which is what a
   * working tunnel amounts to.
   */
  resolvePublicUrl?(publicUrl: string, daemon: RunningDaemon): string;
}

export interface SetupResult {
  /** True only when the endpoint verified too. */
  ok: boolean;
  publicUrl: string;
  endpoint: EndpointHealth;
}

/** Asks until the answer is one Rocky can use, or gives up saying why. */
async function askUntil<T>(
  prompter: Prompter,
  question: string,
  parse: (answer: string) => T,
  maxAttempts: number,
): Promise<T> {
  let lastError = 'no answer given';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const answer = await prompter.ask(question);
    try {
      return parse(answer);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      prompter.say(`  ${lastError}`);
    }
  }

  throw new Error(lastError);
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { prompter } = options;
  const paths = options.paths ?? rockyPaths();
  const host = options.host ?? DEFAULT_HOST;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  prompter.say('Rocky setup');
  prompter.say('');
  prompter.say(
    "Linear fixes an app's webhook URL when the app is created, and it cannot be",
  );
  prompter.say(
    'changed afterwards. So the public URL comes first — before there is an app.',
  );
  prompter.say('');

  const developerName = await askUntil(
    prompter,
    'Your name, as the workspace should see it (the app will be "Rocky (name)"):',
    (answer) => {
      const trimmed = answer.trim();
      if (trimmed.length < 2) {
        throw new Error('Linear needs at least two characters.');
      }
      return trimmed;
    },
    maxAttempts,
  );

  // Step one, and nothing that could create an app happens before it returns.
  prompter.say('');
  prompter.say(
    'Rocky needs one stable, public HTTPS URL that Linear can POST to. It fronts',
  );
  prompter.say(
    'the webhook and nothing else — never the web UI. Recipes for cloudflared,',
  );
  prompter.say('ngrok and Tailscale Funnel are in docs/public-endpoint.md.');
  const publicUrl = await askUntil(
    prompter,
    'Your public URL:',
    assertPublicUrl,
    maxAttempts,
  );

  // Written before the app exists, so a wizard abandoned halfway still leaves
  // the machine one question further along than it was.
  const config = await readInstanceConfig(paths);
  const port = options.port ?? config.server.port ?? DEFAULT_PORT;
  await writeInstanceConfig(paths, { ...config, publicUrl });

  // The daemon serves the OAuth callback and answers the self-ping, so it is
  // up for the rest of the wizard. It is not the daemon the developer will run
  // afterwards — that is what `rocky start` is for.
  const daemon = await startWizardDaemon({
    host,
    port,
    webRoot: false,
    publicUrl: () => publicUrl,
    // The wizard runs its own check at the end, against whatever
    // `resolvePublicUrl` decided; an hourly timer would only get in the way.
    selfPing: false,
  });

  try {
    const redirectUri = oauthRedirectUri(daemon.host, daemon.port);
    const manifest = buildManifest({ developerName, publicUrl, redirectUri });

    prompter.say('');
    prompter.say(
      'Now the human part. Send this link to a workspace admin — an admin has to',
    );
    prompter.say(
      'complete the install, and every admin can see the app afterwards.',
    );
    prompter.say('');
    prompter.say(manifestUrl(manifest));
    prompter.say('');
    prompter.say(
      'They review the pre-filled form, create the app, and send you back its',
    );
    prompter.say('client id, client secret and webhook signing secret.');

    await prompter.waitFor('Press enter once the app exists.');

    const clientId = await askUntil(
      prompter,
      'Client id:',
      (answer) => required(answer, 'client id'),
      maxAttempts,
    );
    const clientSecret = await askUntil(
      prompter,
      'Client secret:',
      (answer) => required(answer, 'client secret'),
      maxAttempts,
    );
    const webhookSecret = await askUntil(
      prompter,
      'Webhook signing secret:',
      (answer) => required(answer, 'webhook signing secret'),
      maxAttempts,
    );

    // The OAuth flow, locally. `actor=app` is what makes Rocky delegatable.
    const state = randomUUID();
    const authorize = authorizeUrl({ clientId, redirectUri, state });
    const waitingForCode = daemon.oauth.expect(state);

    prompter.say('');
    prompter.say('Authorize Rocky in your workspace:');
    prompter.say('');
    prompter.say(authorize);

    const open =
      options.onAuthorizeUrl ??
      (async (url: string) => {
        await prompter.openBrowser?.(url);
      });
    await open(authorize, daemon);

    const code = await waitingForCode;
    const tokens = await exchangeCode(
      { clientId, clientSecret, redirectUri, code },
      { fetch: options.fetch },
    );

    const credentials = await readCredentials(paths);
    await writeCredentials(paths, {
      ...credentials,
      linear: {
        ...credentials.linear,
        clientId,
        clientSecret,
        webhookSecret,
        redirectUri,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
      },
    });

    prompter.say('');
    prompter.say('Authorized. Credentials written to credentials.json (0600).');

    // The last check: does the endpoint actually come back to this machine?
    const dialled = options.resolvePublicUrl?.(publicUrl, daemon) ?? publicUrl;
    const endpoint = await verifyEndpoint(dialled, daemon);

    prompter.say('');
    if (endpoint.ok) {
      prompter.say(`The self-ping reached Rocky through ${publicUrl}.`);
      prompter.say('');
      prompter.say('Setup is done. Run `rocky start`.');
    } else {
      prompter.say(
        `The self-ping did not get back: ${publicUrl} ${endpoint.detail}.`,
      );
      prompter.say(
        'Your credentials are saved — this is the tunnel, not the install. Bring the',
      );
      prompter.say(
        'endpoint up and check it with `rocky doctor`. See docs/public-endpoint.md.',
      );
      prompter.say('');
      prompter.say('Then run `rocky start`.');
    }

    return { ok: endpoint.ok, publicUrl, endpoint };
  } finally {
    await daemon.close();
  }
}

/**
 * Re-running `rocky setup` on a machine that already has a daemon up is a
 * normal thing to do — re-authorizing after a refresh token is finally refused
 * looks exactly like this. The port clash it causes is not, on its own,
 * readable.
 */
async function startWizardDaemon(
  options: Parameters<typeof startDaemon>[0],
): Promise<RunningDaemon> {
  try {
    return await startDaemon(options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Port ${options?.port} is already in use, most likely by a daemon that is already running. Setup needs the port for Linear's OAuth callback — stop it with \`rocky stop\` and run \`rocky setup\` again.`,
      );
    }
    throw error;
  }
}

function required(answer: string, what: string): string {
  const trimmed = answer.trim();
  if (trimmed === '') {
    throw new Error(`Rocky needs the ${what} to continue.`);
  }
  return trimmed;
}

/**
 * A monitor of its own rather than the daemon's, so the wizard can dial
 * whatever `resolvePublicUrl` decided while the daemon keeps the real URL on
 * its own health route. It always uses the real `fetch`: the point of this
 * check is that the round trip leaves the machine.
 */
function verifyEndpoint(
  dialled: string,
  daemon: RunningDaemon,
): Promise<EndpointHealth> {
  return createEndpointMonitor({
    publicUrl: () => dialled,
    instanceId: daemon.instanceId,
  }).check();
}
