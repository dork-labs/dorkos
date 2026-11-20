/**
 * An extension that runs separately and stops on its own is never quiet
 * (DOR-4785): the person is told by name while DorkOS restarts it, once an
 * hour however often it stops, and told again, with a Restart, when DorkOS
 * gives up and leaves it off.
 *
 * Driven through the REAL restart policy and the REAL notification pipeline
 * (store and service), because what is under test is how many rows a person
 * sees across a run of stops, and that is the dedupe the service applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import { RestartPolicy } from '../restart-policy.js';
import { tellExtensionStopped } from '../notices/tell-extension-stopped.js';
import type { ExtensionStopReason } from '../notices/extension-stopped-notice.js';

let store: NotificationStore;
let clock: number;
const tuning = { now: () => clock };
let policy: RestartPolicy;

/** Every `extension.stopped` row, newest first. */
function rows(): NotificationDTO[] {
  return store.list({ limit: 50, unread: false, kind: ['extension.stopped'] }).notifications;
}

/** One unexpected exit, as `onIsolatedExit` reports it. */
async function stop(reason: ExtensionStopReason, id = 'people', name = 'People'): Promise<void> {
  await tellExtensionStopped(id, name, reason, policy.onUnexpectedExit(), tuning);
}

beforeEach(() => {
  const db = createDb(':memory:');
  runMigrations(db);
  store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => undefined);
  clock = Date.parse('2026-11-19T10:00:00.000Z');
  policy = new RestartPolicy(tuning);
});

afterEach(() => {
  setNotificationService(null);
  vi.restoreAllMocks();
});

describe('an extension that stops on its own', () => {
  it('tells the person by name that DorkOS restarted it, quietly, with no button', async () => {
    await stop('server_unresponsive');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      kind: 'extension.stopped',
      tier: 'quiet',
      subject: { type: 'system', id: 'extension:people' },
      title: 'The People app stopped responding. DorkOS is restarting it.',
    });
    expect(rows()[0]!.body).toBeUndefined();
    // It already restarted: a Restart beside that would contradict it. The row
    // itself opens Settings → Extensions.
    expect(rows()[0]!.actions).toBeUndefined();
  });

  it('says a second restart inside the hour once, not twice', async () => {
    await stop('server_unresponsive');
    clock += 60_000;
    await stop('server_crashed');
    expect(rows()).toHaveLength(1);
  });

  it('says it is off, with Restart, when the third stop in 10 minutes ends the restarts', async () => {
    await stop('server_unresponsive');
    clock += 60_000;
    await stop('server_unresponsive');
    clock += 60_000;
    await stop('server_unresponsive');

    const [off, restarted] = rows();
    expect(rows()).toHaveLength(2);
    expect(restarted!.title).toBe('The People app stopped responding. DorkOS is restarting it.');
    expect(off).toMatchObject({
      tier: 'notable',
      subject: { type: 'system', id: 'extension:people' },
      title: 'The People app is off',
      body: 'It stopped 3 times in 10 minutes, so DorkOS left it off.',
      actions: [{ id: 'restart-extension', label: 'Restart', style: 'primary' }],
    });
    expect(off!.readAt).toBeUndefined();
  });

  it('names the reason that ended it', async () => {
    await stop('server_crashed');
    await stop('server_crashed');
    await stop('server_out_of_memory');
    expect(rows()[0]!.body).toBe('It stopped 3 times in 10 minutes, so DorkOS left it off.');
  });

  it('says it is off again after a person restarted it and it gave up a second time', async () => {
    for (let i = 0; i < 3; i++) await stop('server_crashed');
    policy.reset();
    clock += 60_000;
    for (let i = 0; i < 3; i++) await stop('server_crashed');
    expect(rows().filter((row) => row.title === 'The People app is off')).toHaveLength(2);
  });

  it('keeps two apps apart', async () => {
    await stop('server_unresponsive', 'people', 'People');
    await stop('server_unresponsive', 'flow', 'Flow');
    expect(
      rows()
        .map((row) => row.title)
        .sort()
    ).toEqual([
      'The Flow app stopped responding. DorkOS is restarting it.',
      'The People app stopped responding. DorkOS is restarting it.',
    ]);
  });

  it('never fails the restart when no notification service is wired', async () => {
    setNotificationService(null);
    await expect(stop('server_crashed')).resolves.toBeUndefined();
  });
});
