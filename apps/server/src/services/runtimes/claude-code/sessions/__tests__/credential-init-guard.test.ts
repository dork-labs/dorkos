import { credentialInitDeadline } from '../diagnostics/credential-init-guard.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPump } from '../session-pump.js';
import { INIT_TIMEOUT_MS } from '../session-pump-contract.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';
import {
  CredentialsUnreadableError,
  SlowStartError,
  credentialReadCoolingDown,
  credentialReadHealth,
  noteCredentialsReadable,
  noteCredentialsUnreadable,
  resetCredentialReadHealth,
} from '../../tooling/credential-read-health.js';
import { crashResult } from '../diagnostics/session-crash-result.js';
import { logger } from '../../../../../lib/logger.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const ROOT = '/fake/accounts/one';
const OTHER = '/fake/accounts/two';
/** Past the old 15 s credential deadline, still inside the normal start time (DOR-3670). */
const SLOW_START_MS = 20_000;

beforeEach(() => {
  vi.useFakeTimers();
  resetCredentialReadHealth();
});
afterEach(() => {
  resetCredentialReadHealth();
  vi.useRealTimers();
});

describe('a slow start is not a sign-in that cannot be read (DOR-3670)', () => {
  it('lets a relaunch of a healthy account take longer than 15 s to start', async () => {
    noteCredentialsReadable(ROOT);
    const query = new FakeQuery();
    const onCrash = vi.fn();
    const pump = new SessionPump({
      sessionId: 'relaunch',
      launch: () => query,
      credentialAccountRoot: () => ROOT,
      onCrash,
    });
    const warming = pump.warm();
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    query.emit(initMessage());
    await warming;
    expect(pump.state).toBe('warm');
    expect(onCrash).not.toHaveBeenCalled();
    expect(credentialReadHealth(ROOT).state).toBe('healthy');
    query.endStream();
    await vi.advanceTimersByTimeAsync(0);
    await pump.teardown();
  });

  it('calls a start that never comes slow, never unreadable, when no sign-in read hung', async () => {
    noteCredentialsReadable(ROOT);
    const query = new FakeQuery();
    const onCrash = vi.fn();
    const pump = new SessionPump({
      sessionId: 'slow',
      launch: () => query,
      credentialAccountRoot: () => ROOT,
      onCrash,
    });
    const failure = expect(pump.warm()).rejects.toBeInstanceOf(SlowStartError);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    await failure;
    expect(query.closed).toBe(1);
    expect(credentialReadHealth(ROOT).state).toBe('healthy');
    const crash = onCrash.mock.calls[0]![0];
    expect(crash.error.code).toBe('slow_start');
    expect(crashResult(crash)).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['The agent took too long to start. It will try again.'],
    });
    await pump.teardown();
  });

  it('still names an unreadable sign-in when a sign-in read is known to have hung', async () => {
    // What a readiness or expiry probe records when the credential read itself hangs.
    noteCredentialsUnreadable(ROOT);
    const query = new FakeQuery();
    const onCrash = vi.fn();
    const pump = new SessionPump({
      sessionId: 'hung',
      launch: () => query,
      credentialAccountRoot: () => ROOT,
      onCrash,
    });
    const failure = expect(pump.warm()).rejects.toBeInstanceOf(CredentialsUnreadableError);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    await failure;
    expect(query.closed).toBe(1);
    const crash = onCrash.mock.calls[0]![0];
    expect(crash.error.code).toBe('credentials_unreadable');
    expect(crashResult(crash)).toMatchObject({
      subtype: 'credentials_unreadable',
      errors: ["Agents can't read their sign-in. Check this Mac for a password prompt."],
    });
    await pump.teardown();
  });

  it('keeps a known-hung account cooling down after its start times out, and leaves a slow one alone', async () => {
    noteCredentialsUnreadable(ROOT);
    noteCredentialsReadable(OTHER);
    const hung = new SessionPump({
      sessionId: 'hung-cooldown',
      launch: () => new FakeQuery(),
      credentialAccountRoot: () => ROOT,
    });
    const slow = new SessionPump({
      sessionId: 'slow-cooldown',
      launch: () => new FakeQuery(),
      credentialAccountRoot: () => OTHER,
    });
    const failures = Promise.allSettled([hung.warm(), slow.warm()]);
    // Past the probe's own cooldown, so only the timeout can have renewed it.
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    await failures;
    expect(credentialReadCoolingDown(ROOT)).toBe(true);
    expect(credentialReadCoolingDown(OTHER)).toBe(false);
    expect(credentialReadHealth(OTHER).state).toBe('healthy');
    await hung.teardown();
    await slow.teardown();
  });

  it('does not borrow another account’s hung read to diagnose this one', async () => {
    noteCredentialsUnreadable('/fake/accounts/other');
    const query = new FakeQuery();
    const pump = new SessionPump({
      sessionId: 'other',
      launch: () => query,
      credentialAccountRoot: () => ROOT,
    });
    const failure = expect(pump.warm()).rejects.toBeInstanceOf(SlowStartError);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    await failure;
    expect(credentialReadHealth(ROOT).state).toBe('unknown');
    await pump.teardown();
  });
});

describe('how long a start takes (DOR-3670)', () => {
  it('logs the time from launch to init on a successful start', async () => {
    const query = new FakeQuery();
    const pump = new SessionPump({ sessionId: 'timed', launch: () => query });
    const warming = pump.warm();
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    query.emit(initMessage());
    await warming;
    expect(logger.info).toHaveBeenCalledWith('[SessionPump] started', {
      sessionId: 'timed',
      startMs: SLOW_START_MS,
    });
    query.endStream();
    await vi.advanceTimersByTimeAsync(0);
    await pump.teardown();
  });
});

describe('the one-shot query deadline', () => {
  it('sets no deadline while no sign-in read has hung', async () => {
    noteCredentialsReadable(ROOT);
    const guard = credentialInitDeadline({ close: vi.fn() }, ROOT);
    expect(guard.deadline).toBeUndefined();
    guard.dispose();
  });

  it('names an unreadable sign-in after the normal start time, and survives a throwing close', async () => {
    noteCredentialsUnreadable(ROOT);
    const guard = credentialInitDeadline(
      {
        close: () => {
          throw new Error('already closed');
        },
      },
      ROOT
    );
    const failure = expect(guard.deadline).rejects.toBeInstanceOf(CredentialsUnreadableError);
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS - SLOW_START_MS);
    await failure;
    // Renewed at the deadline, past the probe's own 60 s cooldown.
    expect(credentialReadCoolingDown(ROOT)).toBe(true);
    guard.dispose();
  });

  it('cancels the deadline and records the account healthy when init arrives', async () => {
    noteCredentialsUnreadable(ROOT);
    const close = vi.fn();
    const guard = credentialInitDeadline({ close }, ROOT);
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    guard.observe(initMessage() as never);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    expect(close).not.toHaveBeenCalled();
    expect(credentialReadHealth(ROOT).state).toBe('healthy');
  });
});
