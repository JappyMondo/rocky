/**
 * AC2: the wizard cannot be driven into creating the app before the public URL
 * exists. The manifest is where "creating the app" begins, so the refusal lives
 * here rather than in the wizard's prompt loop — there is no order of questions
 * that can produce a manifest without an endpoint to bake into it.
 */
import { describe, expect, it } from 'vitest';

import {
  MANIFEST_SCHEMA_VERSION,
  WEBHOOK_PATH,
  WEBHOOK_RESOURCE_TYPES,
  buildManifest,
  manifestUrl,
  oauthRedirectUri,
  webhookUrl,
} from './manifest.js';

const options = {
  developerName: 'Jan Jaap',
  publicUrl: 'https://rocky-janjaap.example.com',
  redirectUri: 'http://127.0.0.1:7625/api/linear/oauth/callback',
};

describe('the manifest', () => {
  it('bakes the public URL into the webhook URL, which is why it is asked first', () => {
    const manifest = buildManifest(options);

    expect(manifest.webhook.url).toBe(
      `https://rocky-janjaap.example.com${WEBHOOK_PATH}`,
    );
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
  });

  it('subscribes to agent session events', () => {
    expect(buildManifest(options).webhook.resourceTypes).toContain(
      'AgentSessionEvent',
    );
    expect(WEBHOOK_RESOURCE_TYPES).toContain('AgentSessionEvent');
  });

  it('names the app after the developer, so the thread shows whose machine works', () => {
    expect(buildManifest(options).oauth.client_name).toBe('Rocky (Jan Jaap)');
    expect(buildManifest(options).developer.name).toBe('Jan Jaap');
  });

  it('is private, because one app per developer is not a listed integration', () => {
    expect(buildManifest(options).distribution).toBe('private');
  });

  it('carries the daemon`s own callback as the only redirect URI', () => {
    expect(buildManifest(options).oauth.redirect_uris).toEqual([
      options.redirectUri,
    ]);
  });
});

describe('the public URL the manifest refuses', () => {
  it('refuses a missing one', () => {
    expect(() => buildManifest({ ...options, publicUrl: '' })).toThrow(
      /public URL/i,
    );
  });

  it('refuses something that is not a URL at all', () => {
    expect(() =>
      buildManifest({ ...options, publicUrl: 'rocky.example.com' }),
    ).toThrow(/not a URL/);
  });

  it('refuses plain HTTP, which Linear`s own manifest schema rejects', () => {
    expect(() =>
      buildManifest({ ...options, publicUrl: 'http://rocky.example.com' }),
    ).toThrow(/https/i);
  });

  it('refuses localhost, which Linear cannot reach', () => {
    for (const url of [
      'https://localhost:7625',
      'https://127.0.0.1:7625',
      'https://[::1]:7625',
    ]) {
      expect(() => buildManifest({ ...options, publicUrl: url })).toThrow(
        /reach/i,
      );
    }
  });

  it('refuses one carrying a path, query or fragment, which would move the webhook', () => {
    for (const url of [
      'https://rocky.example.com/hook',
      'https://rocky.example.com?x=1',
      'https://rocky.example.com#x',
    ]) {
      expect(() => buildManifest({ ...options, publicUrl: url })).toThrow(
        /host/i,
      );
    }
  });

  it('accepts a trailing slash rather than doubling it into the webhook path', () => {
    const manifest = buildManifest({
      ...options,
      publicUrl: 'https://rocky.example.com/',
    });

    expect(manifest.webhook.url).toBe(
      `https://rocky.example.com${WEBHOOK_PATH}`,
    );
  });
});

describe('the app name Linear`s schema constrains', () => {
  it('refuses a developer name that would put "Linear" in the client name', () => {
    expect(() =>
      buildManifest({ ...options, developerName: 'Linear Fan' }),
    ).toThrow(/Linear/);
  });

  it('refuses a developer name carrying a URL', () => {
    expect(() =>
      buildManifest({ ...options, developerName: 'https://me.example.com' }),
    ).toThrow(/URL/i);
  });

  it('refuses a name too short or too long for the 2–80 character bound', () => {
    expect(() => buildManifest({ ...options, developerName: 'J' })).toThrow(
      /2 and 80/,
    );
    expect(() =>
      buildManifest({ ...options, developerName: 'J'.repeat(80) }),
    ).toThrow(/2 and 80/);
  });
});

describe('the manifest URL handed to the workspace admin', () => {
  it('points at Linear`s create page with the manifest as one parameter', () => {
    const url = new URL(manifestUrl(buildManifest(options)));

    expect(url.origin + url.pathname).toBe(
      'https://linear.app/settings/api/applications/new',
    );
    expect(JSON.parse(url.searchParams.get('manifest') ?? '')).toEqual(
      buildManifest(options),
    );
  });
});

describe('the two URLs derived from the endpoint', () => {
  it('put the webhook on the public URL and the callback on the daemon', () => {
    expect(webhookUrl('https://rocky.example.com')).toBe(
      `https://rocky.example.com${WEBHOOK_PATH}`,
    );
    expect(oauthRedirectUri('127.0.0.1', 7625)).toBe(
      'http://127.0.0.1:7625/api/linear/oauth/callback',
    );
  });
});
