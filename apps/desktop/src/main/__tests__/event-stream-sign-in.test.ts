import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import electronLog from 'electron-log';
import { resetLogMock } from './electron-log-mock';
import { resetElectronMock, session, type MockCookieJar } from './electron-mock';
import {
  RECONNECT_BASE_MS,
  subscribeEventStream,
  type EventStreamHandlers,
  type EventStreamSubscription,
  type GetServerPort,
  type ServerEventFrame,
} from '../event-stream';
import { serverDialHost, serverOrigin } from '../../shared/server-address';
import { COOKIE_READ_TIMEOUT_MS } from '../sign-in/server-cookies';
import { deferred, FakeEventStream } from './fake-event-stream';

/**
 * The event stream when the server asks for a sign-in (DOR-4691).
 *
 * With "Ask for a password on this computer too" on, the session gate answers
 * `GET /api/events` with `401` unless the request carries a sign-in. The shell
 * holds none of its own: the window signs in, and its session keeps the
 * cookie. These tests play that server with {@link FakeEventStream.requiredCookie}
 * and the window's session with the Electron double's cookie jar.
 */

const COOKIE_NAME = 'dorkos.session_token';

let stream: FakeEventStream;
const subscriptions: EventStreamSubscription[] = [];
const extraServers: FakeEventStream[] = [];

/** The window's cookie jar, as the shell reads it. */
function jar(): MockCookieJar {
  return session.defaultSession.cookies;
}

/** Every frame a subscriber has been handed, with a barrier per event name. */
class FrameLog {
  readonly frames: ServerEventFrame[] = [];
  private waiters: { name: string; resolve: () => void }[] = [];

  record = (frame: ServerEventFrame): void => {
    this.frames.push(frame);
    const reached = this.waiters.filter((waiter) => waiter.name === frame.name);
    this.waiters = this.waiters.filter((waiter) => waiter.name !== frame.name);
    for (const waiter of reached) waiter.resolve();
  };

  /** How many frames with this name have arrived. */
  count(name: string): number {
    return this.frames.filter((frame) => frame.name === name).length;
  }

  /**
   * Resolve once `total` frames with this name have arrived in all.
   *
   * @param name - The event name.
   * @param total - The running total to wait for.
   */
  async arrives(name: string, total = 1): Promise<void> {
    while (this.count(name) < total) {
      await new Promise<void>((resolve) => this.waiters.push({ name, resolve }));
    }
  }
}

/** Fake the backoff and read timers; sockets and `setImmediate` stay real. */
function freezeBackoff(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

function subscribe(getPort: GetServerPort, handlers: EventStreamHandlers): EventStreamSubscription {
  const subscription = subscribeEventStream({ getPort }, handlers);
  subscriptions.push(subscription);
  return subscription;
}

beforeEach(async () => {
  resetElectronMock();
  resetLogMock();
  stream = new FakeEventStream();
  await stream.listen();
});

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  vi.useRealTimers();
  await stream.close();
  for (const server of extraServers.splice(0)) await server.close();
});

describe('the event stream signs in with the window (DOR-4691)', () => {
  it("carries the window's sign-in cookie, so a server that asks for a password lets it in", async () => {
    jar().set(COOKIE_NAME, 'token-a');
    stream.requiredCookie = `${COOKIE_NAME}=token-a`;
    const log = new FrameLog();
    subscribe(() => stream.port, { onFrame: log.record });

    await log.arrives('connected');
    expect(stream.cookiesSeen).toEqual([`${COOKIE_NAME}=token-a`]);
    // The cookies asked for are the ones for the origin the window loads.
    expect(jar().askedUrls[0]).toBe(serverOrigin(stream.port));
  });

  it('sends no cookie header when the window holds none, as before', async () => {
    const log = new FrameLog();
    subscribe(() => stream.port, { onFrame: log.record });

    await log.arrives('connected');
    expect(stream.cookiesSeen).toEqual([undefined]);
  });

  it('connects the moment the window signs in, without waiting out the backoff', async () => {
    // Fake timers from the start, so the backoff after the refusal is a timer
    // that never fires: only the sign-in itself can bring the stream back.
    freezeBackoff();
    stream.requiredCookie = `${COOKIE_NAME}=token-a`;
    const log = new FrameLog();
    const refused = deferred();
    subscribe(() => stream.port, {
      onFrame: log.record,
      onConnectionLost: () => refused.resolve(),
    });
    await refused.promise;
    expect(electronLog.warn).toHaveBeenCalledWith(expect.stringContaining('It answered 401'));
    expect(vi.getTimerCount()).toBe(1);

    jar().set(COOKIE_NAME, 'token-a');

    await log.arrives('connected');
    expect(stream.cookiesSeen.at(-1)).toBe(`${COOKIE_NAME}=token-a`);
    // The backoff timer was cancelled, not left to fire a second connection.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers after the sign-in token changes: the next attempt carries the new one', async () => {
    freezeBackoff();
    jar().set(COOKIE_NAME, 'token-a');
    stream.requiredCookie = `${COOKIE_NAME}=token-a`;
    const log = new FrameLog();
    let lost = deferred();
    subscribe(() => stream.port, {
      onFrame: log.record,
      onConnectionLost: () => lost.resolve(),
    });
    await log.arrives('connected');

    // The server ends the old sign-in: it drops the stream and now asks for
    // the new token, so the reconnect with the old one is refused.
    stream.requiredCookie = `${COOKIE_NAME}=token-b`;
    stream.dropClients();
    await lost.promise;
    lost = deferred();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    await lost.promise;
    expect(stream.cookiesSeen).toEqual([`${COOKIE_NAME}=token-a`, `${COOKIE_NAME}=token-a`]);

    // The window signs in again and its session takes the new cookie.
    jar().set(COOKIE_NAME, 'token-b');

    await log.arrives('connected', 2);
    expect(stream.cookiesSeen.at(-1)).toBe(`${COOKIE_NAME}=token-b`);
    stream.sendStatus('session-a', 'streaming');
    await log.arrives('session_status');
  });

  it('a sign-in that lands while an attempt with the old one is out is tried at once when that attempt fails', async () => {
    freezeBackoff();
    jar().set(COOKIE_NAME, 'token-a');
    stream.requiredCookie = `${COOKIE_NAME}=token-b`;
    const log = new FrameLog();
    const release = jar().hold();
    subscribe(() => stream.port, { onFrame: log.record });

    // The read for the first attempt is out, holding token-a. The window
    // signs in again before it answers.
    jar().set(COOKIE_NAME, 'token-b');
    release();

    await log.arrives('connected');
    expect(stream.cookiesSeen).toEqual([`${COOKIE_NAME}=token-a`, `${COOKIE_NAME}=token-b`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnects early only for a cookie on the server host, never another site or an overwrite removal', async () => {
    freezeBackoff();
    stream.requiredCookie = `${COOKIE_NAME}=token-a`;
    const log = new FrameLog();
    const refused = deferred();
    subscribe(() => stream.port, {
      onFrame: log.record,
      onConnectionLost: () => refused.resolve(),
    });
    await refused.promise;

    jar().set('tracker', 'x', { domain: 'example.com' });
    jar().remove('tracker', { domain: serverDialHost(), cause: 'overwrite' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.connections).toBe(1);

    jar().set(COOKIE_NAME, 'token-a', { domain: serverDialHost() });
    await log.arrives('connected');
    expect(stream.connections).toBe(2);
  });

  it('dials nothing when the last subscriber leaves while the sign-in is being read', async () => {
    const release = jar().hold();
    const subscription = subscribe(() => stream.port, { onFrame: () => {} });
    subscription.unsubscribe();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.connections).toBe(0);
  });

  it('goes without a cookie when the store never answers, rather than waiting for good', async () => {
    freezeBackoff();
    jar().set(COOKIE_NAME, 'token-a');
    jar().hold();
    subscribe(() => stream.port, { onFrame: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.connections).toBe(0);

    vi.advanceTimersByTime(COOKIE_READ_TIMEOUT_MS);
    await stream.connectionsReach(1);
    expect(stream.cookiesSeen).toEqual([undefined]);
  });

  it('leaves out a cookie a header cannot carry, and still connects', async () => {
    jar().set('page.note', 'caf€');
    jar().set(COOKIE_NAME, 'token-a');
    const log = new FrameLog();
    subscribe(() => stream.port, { onFrame: log.record });

    await log.arrives('connected');
    expect(stream.cookiesSeen).toEqual([`${COOKIE_NAME}=token-a`]);
  });

  it('leaves a live stream alone when a cookie changes, and backs off as usual after it drops', async () => {
    freezeBackoff();
    jar().set(COOKIE_NAME, 'token-a');
    const log = new FrameLog();
    const lost = deferred();
    subscribe(() => stream.port, { onFrame: log.record, onConnectionLost: () => lost.resolve() });
    await log.arrives('connected');

    jar().set(COOKIE_NAME, 'token-a2');
    stream.dropClients();
    await lost.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.connections).toBe(1);

    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    await log.arrives('connected', 2);
  });

  it('comes back after a server restart on the same port, still signed in', async () => {
    jar().set(COOKIE_NAME, 'token-a');
    stream.requiredCookie = `${COOKIE_NAME}=token-a`;
    const log = new FrameLog();
    const lost = deferred();
    subscribe(() => stream.port, {
      onFrame: log.record,
      onConnectionLost: () => lost.resolve(),
    });
    await log.arrives('connected');

    const { port } = stream;
    await stream.close();
    await lost.promise;

    const restarted = new FakeEventStream();
    extraServers.push(restarted);
    restarted.requiredCookie = `${COOKIE_NAME}=token-a`;
    await restarted.listen('127.0.0.1', port);

    await log.arrives('connected', 2);
    expect(restarted.cookiesSeen.at(-1)).toBe(`${COOKIE_NAME}=token-a`);
    restarted.sendStatus('session-a', 'streaming');
    await log.arrives('session_status');
  });

  it('stops listening for sign-in changes once the last subscriber lets go', async () => {
    const log = new FrameLog();
    const subscription = subscribe(() => stream.port, { onFrame: log.record });
    await log.arrives('connected');
    expect(jar().listenerCount).toBe(1);

    subscription.unsubscribe();
    expect(jar().listenerCount).toBe(0);

    // A sign-in after that opens nothing.
    jar().set(COOKIE_NAME, 'token-a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.connections).toBe(1);
  });
});
