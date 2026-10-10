/**
 * What remote access does by itself (DOR-2086 S5): the boot rule, every row
 * of it; a managed boot that only ever reconnects the command stream; the
 * stream following login and availability after boot; and a shutdown that
 * drains within the deadline and keeps what is owed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';

import { configManager } from '../../config-manager.js';
import { ActivityOutbox } from '../activity-outbox.js';
import { CommandDispatcher } from '../command-dispatcher.js';
import type { AvailabilitySnapshot } from '../managed-availability.js';
import { ManagedCommandService } from '../managed-command-service.js';
import { MANAGED_DRAIN_DEADLINE_MS } from '../managed-ingress.js';
import {
  autostartOwnTunnel,
  currentRemoteBootPlan,
  planRemoteBoot,
  type RemoteBootPlan,
} from '../remote-boot.js';
import { readRemoteState, updateRemoteState } from '../remote-state.js';
import { commandWorld, INSTANCE_ID, type CommandWorld } from './command-harness.js';

describe('the boot rule', () => {
  // Every combination of the three inputs, and what each must do.
  const rows: Array<[boolean | undefined, boolean, boolean, RemoteBootPlan]> = [
    // TUNNEL_ENABLED=true: the person's own tunnel, for this process, whatever is saved.
    [true, false, false, { ownTunnel: true, reconnectManaged: false }],
    [true, true, false, { ownTunnel: true, reconnectManaged: false }],
    [true, false, true, { ownTunnel: true, reconnectManaged: false }],
    [true, true, true, { ownTunnel: true, reconnectManaged: false }],
    // TUNNEL_ENABLED=false: nothing comes back on its own, in either mode.
    [false, false, false, { ownTunnel: false, reconnectManaged: false }],
    [false, true, false, { ownTunnel: false, reconnectManaged: false }],
    [false, false, true, { ownTunnel: false, reconnectManaged: false }],
    [false, true, true, { ownTunnel: false, reconnectManaged: false }],
    // Unset: a saved managed choice wins over an older saved tunnel.enabled=true.
    [undefined, false, false, { ownTunnel: false, reconnectManaged: false }],
    [undefined, true, false, { ownTunnel: true, reconnectManaged: false }],
    [undefined, false, true, { ownTunnel: false, reconnectManaged: true }],
    [undefined, true, true, { ownTunnel: false, reconnectManaged: true }],
  ];

  it.each(rows)(
    'TUNNEL_ENABLED=%s, saved tunnel.enabled=%s, saved managed=%s',
    (tunnelEnabledEnv, storedTunnelEnabled, managedSelected, expected) => {
      expect(planRemoteBoot({ tunnelEnabledEnv, storedTunnelEnabled, managedSelected })).toEqual(
        expected
      );
    }
  );
});

describe('the boot rule over the saved config', () => {
  let w: CommandWorld;
  beforeEach(async () => {
    w = await commandWorld();
  });
  afterEach(() => w.cleanup());

  it('a managed choice outranks the saved own-tunnel flag, which stays saved', () => {
    configManager.set('tunnel', { ...configManager.get('tunnel'), enabled: true });
    expect(currentRemoteBootPlan({ TUNNEL_ENABLED: undefined })).toEqual({
      ownTunnel: false,
      reconnectManaged: true,
    });
    expect(configManager.get('tunnel')?.enabled).toBe(true);
    // Switching back is a person's choice; then the saved flag works again.
    updateRemoteState('test', { mode: 'byo' });
    expect(currentRemoteBootPlan({ TUNNEL_ENABLED: undefined })).toEqual({
      ownTunnel: true,
      reconnectManaged: false,
    });
  });
});

describe('the own tunnel at boot', () => {
  const base = {
    env: { TUNNEL_ENABLED: undefined },
    stored: undefined,
    fallbackPort: 4241,
    apiPort: 4242,
  };

  it('opens only when the plan says so, and never past canExpose()', async () => {
    const tunnel = { start: vi.fn(async () => 'https://own.ngrok.app') };
    const own = { ownTunnel: true, reconnectManaged: false };
    await autostartOwnTunnel({ ...base, plan: own, canExpose: () => false, tunnel });
    expect(tunnel.start).not.toHaveBeenCalled();
    await autostartOwnTunnel({
      ...base,
      plan: { ownTunnel: false, reconnectManaged: true },
      canExpose: () => true,
      tunnel,
    });
    expect(tunnel.start).not.toHaveBeenCalled();
    await autostartOwnTunnel({ ...base, plan: own, canExpose: () => true, tunnel });
    expect(tunnel.start).toHaveBeenCalledWith(expect.objectContaining({ port: 4241 }));
  });

  it('never throws when ngrok refuses', async () => {
    const tunnel = { start: vi.fn(async () => Promise.reject(new Error('ngrok'))) };
    await expect(
      autostartOwnTunnel({
        ...base,
        plan: { ownTunnel: true, reconnectManaged: false },
        canExpose: () => true,
        tunnel,
      })
    ).resolves.toBeUndefined();
  });
});

describe('the managed command stream after boot', () => {
  let w: CommandWorld;
  beforeEach(async () => {
    w = await commandWorld();
  });
  afterEach(() => w.cleanup());

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i += 1) await tick();
    expect(check()).toBe(true);
  }

  function service(
    facts: {
      canExpose: boolean;
      availability: AvailabilitySnapshot['availability'];
    } = { canExpose: true, availability: 'available' }
  ) {
    const opened: AbortSignal[] = [];
    let changed: () => void = () => undefined;
    const activity = {
      opened: vi.fn(),
      stop: vi.fn(),
      drainDeadlineMs: undefined as number | undefined,
    };
    const tunnel = {
      phase: null as null | 'open',
      getManagedPhase: () => tunnel.phase,
      closeManaged: vi.fn(async () => {
        tunnel.phase = null;
      }),
    };
    const svc = new ManagedCommandService({
      availability: {
        enabled: true,
        read: async () => ({
          availability: facts.availability,
          instanceId: INSTANCE_ID,
          cloudStatus: null,
          cloudStale: false,
        }),
        markAbsent: vi.fn(),
      },
      captureContext: w.cloud.capture,
      readRemoteState,
      canExpose: () => facts.canExpose,
      dispatcher: (journal, onSettled, onOpened) =>
        new CommandDispatcher({
          journal,
          tunnelManager: w.tunnel,
          remoteCredentials: w.credentials,
          readRemoteState,
          updateRemoteState,
          onSettled,
          onOpened,
        }),
      openStream: async (_context, signal) => {
        opened.push(signal);
        // Stays open until aborted.
        const body = new ReadableStream<Uint8Array>({});
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
      stream: { sleep: async () => undefined, random: () => 0.5 },
      activity,
      tunnel,
      watchChanges: (onChange) => {
        changed = onChange;
        return () => {
          changed = () => undefined;
        };
      },
      random: () => 0.5,
    });
    return { svc, opened, facts, activity, tunnel, change: () => changed() };
  }

  it('a boot the rule holds down connects nothing, until a person asks', async () => {
    const s = service();
    s.svc.boot(w.db, { reconnectManaged: false });
    await s.svc.reconcile();
    await tick();
    expect(s.opened).toHaveLength(0);
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
    expect(await s.svc.start()).toBe(true);
    await until(() => s.opened.length === 1);
    await s.svc.shutdown();
  });

  it('a managed boot reconnects the stream and opens nothing', async () => {
    const s = service();
    s.svc.boot(w.db, { reconnectManaged: true });
    await until(() => s.opened.length === 1);
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
    await s.svc.shutdown();
  });

  it('a computer whose saved choice is not managed reconnects nothing', async () => {
    updateRemoteState('test', { mode: 'byo' });
    const s = service();
    s.svc.boot(w.db, { reconnectManaged: true });
    await s.svc.reconcile();
    expect(s.opened).toHaveLength(0);
    await s.svc.shutdown();
  });

  it('starts when login turns on after boot, and stops when it turns off again', async () => {
    const s = service({ canExpose: false, availability: 'available' });
    s.svc.boot(w.db, { reconnectManaged: true });
    await tick();
    expect(s.svc.running).toBe(false);

    s.facts.canExpose = true;
    s.change();
    await until(() => s.svc.running && s.opened.length === 1);

    s.facts.canExpose = false;
    s.change();
    await until(() => !s.svc.running);
    expect(s.opened[0]!.aborted).toBe(true);
    await s.svc.shutdown();
  });

  it('starts when Cloud starts offering managed access, and keeps running through a blip', async () => {
    const s = service({ canExpose: true, availability: 'hidden' });
    s.svc.boot(w.db, { reconnectManaged: true });
    await tick();
    expect(s.svc.running).toBe(false);

    s.facts.availability = 'available';
    await s.svc.reconcile();
    await until(() => s.opened.length === 1);

    // Cloud's status could not be read just now: the stream stays.
    s.facts.availability = 'unavailable';
    await s.svc.reconcile();
    expect(s.svc.running).toBe(true);
    // Cloud no longer offers it: the stream goes.
    s.facts.availability = 'hidden';
    await s.svc.reconcile();
    expect(s.svc.running).toBe(false);
    await s.svc.shutdown();
  });

  it('shutdown cancels the stream, drains within the active deadline and keeps what is owed', async () => {
    w.cloud.on('POST', '/v1/remote/events', { networkError: true });
    const s = service();
    s.svc.boot(w.db, { reconnectManaged: true });
    await until(() => s.opened.length === 1);
    s.svc.reportActivity({
      instanceId: INSTANCE_ID,
      activity: [{ at: '2026-10-10T12:00:00.000Z', requests: 3 }],
      closeReports: [],
    });
    s.tunnel.phase = 'open';
    s.activity.drainDeadlineMs = 12_000;

    await s.svc.shutdown();
    expect(s.opened[0]!.aborted).toBe(true);
    expect(s.svc.running).toBe(false);
    expect(s.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: 12_000,
      reason: 'shutdown',
    });
    expect(s.activity.stop).toHaveBeenCalled();
    // Cloud could not be reached: the batch waits for the next start.
    expect(new ActivityOutbox(w.db).size()).toBe(1);
  });

  it('shutdown never drains longer than the local default', async () => {
    const s = service();
    s.svc.boot(w.db, { reconnectManaged: false });
    s.tunnel.phase = 'open';
    s.activity.drainDeadlineMs = 10 * 60_000;
    await s.svc.shutdown();
    expect(s.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: MANAGED_DRAIN_DEADLINE_MS,
      reason: 'shutdown',
    });
  });

  it('an activity batch written before a crash is sent under its key on the next start', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const before = new ActivityOutbox(db, Date.now, () => 'key-before-crash');
    before.enqueue({
      instanceId: INSTANCE_ID,
      activity: [{ at: '2026-10-10T12:00:00.000Z', requests: 1 }],
      closeReports: [],
    });
    w.cloud.on('POST', '/v1/remote/events', { status: 200, body: { accepted: 1 } });
    const s = service();
    s.svc.boot(db, { reconnectManaged: true });
    await until(() => w.cloud.callsTo('POST', '/v1/remote/events').length === 1);
    expect(w.cloud.callsTo('POST', '/v1/remote/events')[0]!.headers['idempotency-key']).toBe(
      'key-before-crash'
    );
    await s.svc.shutdown();
  });
});
