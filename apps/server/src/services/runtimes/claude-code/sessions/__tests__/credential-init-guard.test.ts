import { credentialInitDeadline } from '../diagnostics/credential-init-guard.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPump } from '../session-pump.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';
import {
  CREDENTIAL_INIT_TIMEOUT_MS,
  CredentialsUnreadableError,
  credentialReadHealth,
  credentialsRecentlyReadable,
  RECENT_CREDENTIAL_HEALTH_MS,
  noteCredentialsReadable,
  resetCredentialReadHealth,
} from '../../tooling/credential-read-health.js';
import { crashResult } from '../diagnostics/session-crash-result.js';

const ROOT = '/fake/accounts/one';
beforeEach(() => {
  vi.useFakeTimers();
  resetCredentialReadHealth();
});
afterEach(() => {
  resetCredentialReadHealth();
  vi.useRealTimers();
});

describe('a fake runtime that never initializes', () => {
  it('preserves the unreadable diagnosis if closing a hung query throws', async () => {
    noteCredentialsReadable(ROOT);
    const guard = credentialInitDeadline(
      {
        close: () => {
          throw new Error('already closed');
        },
      },
      ROOT
    );
    const failure = expect(guard.deadline).rejects.toBeInstanceOf(CredentialsUnreadableError);
    await vi.advanceTimersByTimeAsync(CREDENTIAL_INIT_TIMEOUT_MS);
    await failure;
    expect(credentialReadHealth(ROOT).state).toBe('credentials_unreadable');
    guard.dispose();
  });
  it('does not treat stale health as evidence of a recently readable account', async () => {
    noteCredentialsReadable(ROOT);
    await vi.advanceTimersByTimeAsync(RECENT_CREDENTIAL_HEALTH_MS + 1);
    expect(credentialsRecentlyReadable(ROOT)).toBe(false);
  });

  it('names unreadable credentials on a recently healthy account and closes only that query', async () => {
    noteCredentialsReadable(ROOT);
    const query = new FakeQuery();
    const onCrash = vi.fn();
    const pump = new SessionPump({
      sessionId: 'hung',
      launch: () => query,
      credentialAccountRoot: () => ROOT,
      onCrash,
    });
    const warming = pump.warm();
    const failure = expect(warming).rejects.toBeInstanceOf(CredentialsUnreadableError);
    await vi.advanceTimersByTimeAsync(CREDENTIAL_INIT_TIMEOUT_MS);
    await failure;
    expect(query.closed).toBe(1);
    expect(credentialReadHealth(ROOT)).toMatchObject({ state: 'credentials_unreadable' });
    const crash = onCrash.mock.calls[0]![0];
    expect(crash.error.code).toBe('credentials_unreadable');
    expect(crashResult(crash)).toMatchObject({
      subtype: 'credentials_unreadable',
      errors: ["Agents can't read their sign-in. Check this Mac for a password prompt."],
    });
    await pump.teardown();
  });
  it('does not borrow another account’s health to diagnose a cold account', async () => {
    noteCredentialsReadable('/fake/accounts/other');
    const query = new FakeQuery();
    const pump = new SessionPump({
      sessionId: 'cold',
      launch: () => query,
      credentialAccountRoot: () => ROOT,
    });
    const warming = pump.warm().catch(() => {});
    await vi.advanceTimersByTimeAsync(CREDENTIAL_INIT_TIMEOUT_MS);
    expect(pump.state).toBe('warming');
    expect(credentialReadHealth(ROOT).state).toBe('unknown');
    query.endStream();
    await vi.advanceTimersByTimeAsync(0);
    await pump.teardown();
    await warming;
  });
  it('cancels the short deadline when init arrives, even while the turn stays open', async () => {
    noteCredentialsReadable(ROOT);
    let activeRoot = ROOT;
    const query = new FakeQuery();
    const pump = new SessionPump({
      sessionId: 'ready',
      launch: () => query,
      credentialAccountRoot: () => activeRoot,
    });
    const warming = pump.warm();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_INIT_TIMEOUT_MS - 1);
    activeRoot = '/fake/accounts/other';
    query.emit(initMessage());
    await warming;
    await vi.advanceTimersByTimeAsync(CREDENTIAL_INIT_TIMEOUT_MS);
    expect(pump.state).toBe('warm');
    expect(credentialReadHealth(activeRoot).state).toBe('unknown');
    expect(credentialReadHealth(ROOT).state).toBe('healthy');
    expect(query.closed).toBe(0);
    query.endStream();
    await vi.advanceTimersByTimeAsync(0);
    await pump.teardown();
  });
});
