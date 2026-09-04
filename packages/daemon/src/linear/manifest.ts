/**
 * The OAuth app manifest, and the URL a developer hands to their workspace
 * admin (NG-600).
 *
 * Linear pins a webhook URL to the OAuth *client* at creation, and the only
 * programmatic way to move it afterwards is an ALPHA mutation needing a
 * managing app — which NG-578 rejected outright. That single fact is why
 * `rocky setup` asks for the public URL before anything else, and it is why the
 * refusal lives here rather than in the wizard's prompt loop: a manifest cannot
 * be built at all without an endpoint to bake in, so no order of questions can
 * reach app creation early.
 *
 * Field names and bounds below are Linear's, from the published manifest schema
 * at `linear.app/.well-known/oauth-app-manifest.schema.json` (NG-567 §6). They
 * are snake_case under `oauth` and camelCase elsewhere because Linear's schema
 * is.
 */

/** The only version Linear's schema accepts. */
export const MANIFEST_SCHEMA_VERSION = '1.0.0';

/** Where Linear's create page lives. */
const CREATE_PAGE = 'https://linear.app/settings/api/applications/new';

/** The one path the public endpoint has to front. */
export const WEBHOOK_PATH = '/api/linear/webhook';

/**
 * Where Linear sends the developer back after they authorize. It is the
 * daemon's own port, not a throwaway listener: the redirect URI is as fixed at
 * creation as the webhook URL, so re-authorizing later — after a refresh token
 * finally fails — has to land somewhere that still exists.
 */
export const OAUTH_CALLBACK_PATH = '/api/linear/oauth/callback';

/**
 * `AgentSessionEvent` is the one Rocky acts on today. The other two are
 * subscribed now because this list is as fixed at creation as the URL is:
 * `PermissionChange` tells Rocky its team access moved, and
 * `AppUserNotification` covers being unassigned (NG-567 §7). The receiver
 * answers anything it does not handle with a 200 rather than a retry.
 */
export const WEBHOOK_RESOURCE_TYPES = [
  'AgentSessionEvent',
  'AppUserNotification',
  'PermissionChange',
] as const;

export interface ManifestOptions {
  /** The developer, as they should appear in the workspace. */
  developerName: string;
  /** The BYO stable endpoint. Origin only — no path. */
  publicUrl: string;
  /** The daemon's OAuth callback, from `oauthRedirectUri`. */
  redirectUri: string;
}

export interface OAuthAppManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  distribution: 'private';
  developer: { name: string };
  display: { description: string };
  oauth: {
    client_name: string;
    redirect_uris: string[];
    grant_types: string[];
  };
  webhook: {
    url: string;
    resourceTypes: string[];
    enabled: boolean;
  };
}

/**
 * The endpoint has to be an origin Linear can actually POST to. Every rejection
 * here is a failure Linear would otherwise surface hours later, as a webhook
 * that never arrives on an app whose URL can no longer be changed.
 */
export function assertPublicUrl(publicUrl: string): string {
  if (publicUrl.trim() === '') {
    throw new Error(
      'Rocky needs a public URL before the Linear app can be created — Linear fixes the webhook URL when the app is made, and it cannot be changed afterwards.',
    );
  }

  let url: URL;
  try {
    url = new URL(publicUrl.trim());
  } catch {
    throw new Error(`"${publicUrl}" is not a URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(
      `The public URL must be https — Linear's manifest schema rejects anything else, and "${publicUrl}" is ${url.protocol.replace(':', '')}.`,
    );
  }

  if (isLoopback(url.hostname)) {
    throw new Error(
      `Linear has to reach this URL from the internet, and "${url.hostname}" only resolves on your own machine. See docs/public-endpoint.md for a tunnel recipe.`,
    );
  }

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `The public URL must be a bare host like https://rocky.example.com — Rocky appends ${WEBHOOK_PATH} to it, and "${publicUrl}" already carries more than a host.`,
    );
  }

  return url.origin;
}

function isLoopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare.endsWith('.localhost') ||
    /^127\./.test(bare)
  );
}

/** Where Linear posts agent-session events. */
export function webhookUrl(publicUrl: string): string {
  return `${assertPublicUrl(publicUrl)}${WEBHOOK_PATH}`;
}

/** Where Linear sends the developer back after they authorize. */
export function oauthRedirectUri(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}${OAUTH_CALLBACK_PATH}`;
}

/**
 * `developer.name` carries its own 2–80 bound in Linear's schema, separate from
 * the one on `client_name` — and it is the one that bites first, because
 * wrapping a name in `Rocky (…)` can only ever push it over the upper bound.
 */
function assertDeveloperName(developerName: string): string {
  if (developerName.length < 2 || developerName.length > 80) {
    throw new Error(
      `Linear requires the developer name to be between 2 and 80 characters, and "${developerName}" is ${developerName.length}.`,
    );
  }
  return developerName;
}

/**
 * Two of Linear's own regexes, restated as a readable refusal. `client_name`
 * "must not contain Linear" case-insensitively and "must not contain http:// or
 * https://" — both are rejected by the create page rather than explained by it.
 */
function assertClientName(clientName: string, developerName: string): string {
  if (clientName.length < 2 || clientName.length > 80) {
    throw new Error(
      `The app would be named "${clientName}", and Linear requires an app name between 2 and 80 characters.`,
    );
  }
  if (/linear/i.test(clientName)) {
    throw new Error(
      `Linear rejects an app name containing "Linear", and "${developerName}" would make one. Use a different name.`,
    );
  }
  if (/https?:\/\//i.test(clientName)) {
    throw new Error(
      `Linear rejects an app name containing a URL, and "${developerName}" would make one. Use a plain name.`,
    );
  }
  return clientName;
}

export function buildManifest(options: ManifestOptions): OAuthAppManifest {
  const developerName = assertDeveloperName(options.developerName.trim());
  const clientName = assertClientName(
    `Rocky (${developerName})`,
    developerName,
  );

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    // One app per developer is nobody else's to install, and `public` would
    // additionally require a `client_uri`.
    distribution: 'private',
    developer: { name: developerName },
    display: {
      description: `Rocky on ${developerName}'s machine. Delegate an issue to it and the Run happens there.`,
    },
    oauth: {
      client_name: clientName,
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code'],
    },
    webhook: {
      url: webhookUrl(options.publicUrl),
      resourceTypes: [...WEBHOOK_RESOURCE_TYPES],
      enabled: true,
    },
  };
}

/**
 * The link the developer hands to their workspace admin. The manifest travels
 * as one query parameter, so the admin reviews a pre-filled form instead of
 * copying nine fields — but the admin still has to be a human, because
 * `actor=app` installs need admin permission (NG-567 §6).
 */
export function manifestUrl(manifest: OAuthAppManifest): string {
  const url = new URL(CREATE_PAGE);
  url.searchParams.set('manifest', JSON.stringify(manifest));
  return url.toString();
}
