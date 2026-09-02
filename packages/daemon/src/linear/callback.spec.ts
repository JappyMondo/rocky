/**
 * The OAuth callback broker: who is waiting for which `state`, and what
 * happens to everyone else.
 */
import { describe, expect, it } from 'vitest';

import { OAuthCallbackError, createOAuthCallbackBroker } from './callback.js';

describe('delivering a code', () => {
  it('resolves the wait for that state', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = broker.expect('state-1');

    expect(broker.deliver({ state: 'state-1', code: 'the-code' })).toBe(true);
    expect(await waiting).toBe('the-code');
  });

  it('keeps two flows apart', async () => {
    const broker = createOAuthCallbackBroker();
    const first = broker.expect('state-1');
    const second = broker.expect('state-2');

    broker.deliver({ state: 'state-2', code: 'second-code' });
    broker.deliver({ state: 'state-1', code: 'first-code' });

    expect(await first).toBe('first-code');
    expect(await second).toBe('second-code');
  });

  it('is delivered once — a replayed callback finds nobody waiting', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = broker.expect('state-1');

    expect(broker.deliver({ state: 'state-1', code: 'the-code' })).toBe(true);
    expect(broker.deliver({ state: 'state-1', code: 'the-code' })).toBe(false);
    await waiting;
  });
});

describe('a callback nobody asked for', () => {
  it('is refused when the state is unknown', () => {
    const broker = createOAuthCallbackBroker();

    expect(broker.deliver({ state: 'never-issued', code: 'x' })).toBe(false);
  });

  it('is refused when there is no state at all', () => {
    const broker = createOAuthCallbackBroker();
    broker.expect('state-1');

    // No `state` means it cannot be matched to a flow, so it is not one.
    expect(broker.deliver({ code: 'x' })).toBe(false);
  });
});

describe('a callback that carries no code', () => {
  it('rejects with Linear`s error when it sent one', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = expect(broker.expect('state-1')).rejects.toThrow(
      /access_denied/,
    );

    expect(broker.deliver({ state: 'state-1', error: 'access_denied' })).toBe(
      true,
    );
    await waiting;
  });

  it('rejects with something readable when it sent neither', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = expect(broker.expect('state-1')).rejects.toThrow(
      /without an authorization code/,
    );

    expect(broker.deliver({ state: 'state-1' })).toBe(true);
    await waiting;
  });

  it('rejects with an OAuthCallbackError either way', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = expect(broker.expect('state-1')).rejects.toBeInstanceOf(
      OAuthCallbackError,
    );

    broker.deliver({ state: 'state-1', error: 'server_error' });
    await waiting;
  });
});

describe('cancelling', () => {
  it('rejects the wait, so an abandoned wizard does not leak a promise', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = expect(broker.expect('state-1')).rejects.toThrow(
      /cancelled/,
    );

    broker.cancel('state-1');
    await waiting;
  });

  it('takes a reason when there is a better one to give', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = expect(broker.expect('state-1')).rejects.toThrow(
      /took too long/,
    );

    broker.cancel('state-1', 'the authorization took too long');
    await waiting;
  });

  it('is harmless when nothing is waiting', () => {
    const broker = createOAuthCallbackBroker();

    expect(() => broker.cancel('never-issued')).not.toThrow();
  });

  it('leaves the state unclaimed, so a late callback is refused', async () => {
    const broker = createOAuthCallbackBroker();
    const waiting = expect(broker.expect('state-1')).rejects.toThrow();

    broker.cancel('state-1');
    await waiting;

    expect(broker.deliver({ state: 'state-1', code: 'too-late' })).toBe(false);
  });
});
