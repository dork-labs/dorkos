import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { WebPushPayload } from '@dorkos/shared/notification-schemas';
import { PushSubscriptionStore } from '../push-subscription-store.js';
import { WebPushChannel, vapidKeyPath, type WebPushSender } from '../channels/web-push.js';

let db: Db;
let dorkHome: string;
let subscriptions: PushSubscriptionStore;

/** The payload every case sends — the whole contract, and nothing more. */
const PAYLOAD: WebPushPayload = {
  title: 'acme is waiting on your answer',
  body: 'Wants to run Bash',
  deepLink: '/session?session=sess-1',
  notificationId: 'ask:int-1',
  tier: 'blocking',
};

/** A sender that records what it was asked to send. */
function sender(impl?: WebPushSender['sendNotification']): {
  channel: WebPushChannel;
  sendNotification: ReturnType<typeof vi.fn>;
} {
  const sendNotification = vi.fn(impl ?? (() => Promise.resolve({})));
  const channel = new WebPushChannel({
    dorkHome,
    subscriptions,
    sender: { sendNotification } as unknown as WebPushSender,
  });
  return { channel, sendNotification };
}

/** Subscribe one browser at a given endpoint. */
function subscribe(endpoint: string): string {
  return subscriptions.upsert({ endpoint, keys: { p256dh: 'pub-key', auth: 'auth-key' } }).id;
}

/** The error shape a push service's rejection takes. */
function pushRejection(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`push failed: ${statusCode}`), { statusCode });
}

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  subscriptions = new PushSubscriptionStore(db);
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-push-'));
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('VAPID keys', () => {
  it('generates a keypair on first use and stores it 0600 inside a 0700 directory', () => {
    const { channel } = sender();

    const key = channel.publicKey();

    expect(key).toBeTruthy();
    const file = vapidKeyPath(dorkHome);
    expect(fs.existsSync(file)).toBe(true);
    // The private half authorises a push to every browser subscribed here, so
    // the permissions are the point, not a nicety.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('reuses the stored keypair rather than rotating it', () => {
    const first = sender().channel.publicKey();
    // A new channel over the same home is what a server restart looks like. A
    // rotated key would silently break every browser already subscribed.
    const second = sender().channel.publicKey();

    expect(second).toBe(first);
  });

  it('replaces a keypair file that cannot be read', () => {
    const file = vapidKeyPath(dorkHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all');

    const key = sender().channel.publicKey();

    expect(key).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toHaveProperty('privateKey');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reports push as unavailable rather than throwing when the keys cannot be written', () => {
    // A read-only data directory: push is off, and every caller already handles
    // that. Failing outright here would take the chat leg down with it.
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });

    expect(sender().channel.publicKey()).toBeNull();
  });
});

describe('sending', () => {
  it('sends the payload verbatim to every subscribed browser', async () => {
    subscribe('https://fcm.googleapis.com/one');
    subscribe('https://web.push.apple.com/two');
    const { channel, sendNotification } = sender();

    const result = await channel.sendToAll(PAYLOAD);

    expect(result.delivered).toBe(2);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sendNotification.mock.calls[0][1] as string)).toEqual(PAYLOAD);
  });

  it('does nothing at all when nobody is subscribed', async () => {
    const { channel, sendNotification } = sender();

    expect(await channel.sendToAll(PAYLOAD)).toEqual({ delivered: 0, pruned: 0, outcomes: [] });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('prunes a subscription the push service says is gone', async () => {
    const id = subscribe('https://fcm.googleapis.com/dead');
    const { channel } = sender(() => Promise.reject(pushRejection(410)));

    const result = await channel.sendToAll(PAYLOAD);

    expect(result).toMatchObject({ delivered: 0, pruned: 1 });
    // A dead endpoint retried forever is a slow request on the path of the one
    // message that matters most.
    expect(subscriptions.list().map((row) => row.id)).not.toContain(id);
  });

  it('prunes on 404 too, which is the other way a browser says it is gone', async () => {
    subscribe('https://fcm.googleapis.com/dead');
    const { channel } = sender(() => Promise.reject(pushRejection(404)));

    expect((await channel.sendToAll(PAYLOAD)).pruned).toBe(1);
    expect(subscriptions.list()).toHaveLength(0);
  });

  it('keeps a subscription whose push merely failed', async () => {
    // A 500 or a timeout is the push service having a bad minute, not the
    // browser being gone. Dropping the row would silently unsubscribe somebody.
    subscribe('https://fcm.googleapis.com/flaky');
    const { channel } = sender(() => Promise.reject(pushRejection(500)));

    const result = await channel.sendToAll(PAYLOAD);

    expect(result).toMatchObject({ delivered: 0, pruned: 0 });
    expect(subscriptions.list()).toHaveLength(1);
  });

  it('one dead device does not stop the others being reached', async () => {
    subscribe('https://fcm.googleapis.com/dead');
    subscribe('https://web.push.apple.com/alive');
    const { channel } = sender((subscription) =>
      subscription.endpoint.includes('dead')
        ? Promise.reject(pushRejection(410))
        : Promise.resolve({})
    );

    const result = await channel.sendToAll(PAYLOAD);

    expect(result).toMatchObject({ delivered: 1, pruned: 1 });
  });

  it('never throws, whatever the transport does', async () => {
    subscribe('https://fcm.googleapis.com/one');
    const { channel } = sender(() => Promise.reject(new Error('DNS is on fire')));

    await expect(channel.sendToAll(PAYLOAD)).resolves.toMatchObject({ delivered: 0 });
  });

  it('notes that a browser was reached, so the device list stays honest', async () => {
    // Fake time, because a real clock can advance zero milliseconds between the
    // subscribe and the send — which would make the assertion below pass or fail
    // by luck rather than by whether `touch` was called.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
      const id = subscribe('https://fcm.googleapis.com/one');
      const before = subscriptions.list().find((row) => row.id === id)!.lastSeenAt;

      vi.setSystemTime(new Date('2026-08-20T09:01:00.000Z'));
      await sender().channel.sendToAll(PAYLOAD);

      expect(subscriptions.list().find((row) => row.id === id)!.lastSeenAt).toBe(
        '2026-08-20T09:01:00.000Z'
      );
      expect(before).toBe('2026-08-20T09:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the list may say', () => {
  it('never returns an endpoint — only the push service that holds it', () => {
    subscribe('https://web.push.apple.com/very-secret-capability-url');

    const listed = subscriptions.list();

    expect(listed[0].service).toBe('web.push.apple.com');
    expect(JSON.stringify(listed)).not.toContain('very-secret-capability-url');
  });

  it('refreshes a browser that re-subscribes rather than adding a second row', () => {
    const first = subscriptions.upsert({
      endpoint: 'https://fcm.googleapis.com/one',
      keys: { p256dh: 'old', auth: 'old' },
    });
    const second = subscriptions.upsert({
      endpoint: 'https://fcm.googleapis.com/one',
      keys: { p256dh: 'new', auth: 'new' },
    });

    expect(second.id).toBe(first.id);
    expect(subscriptions.list()).toHaveLength(1);
    expect(subscriptions.all()[0].keys).toEqual({ p256dh: 'new', auth: 'new' });
  });
});
