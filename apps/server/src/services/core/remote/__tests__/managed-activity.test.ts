/**
 * The managed remote access activity window and idle close (DOR-2086 S5):
 * only requests past the edge proof AND the session gate count, a close
 * reports its span, and the idle timer fires on time and dies with the
 * session, whatever ended it.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initConfigManager } from '../../config-manager.js';
import { sessionGate } from '../../auth/session-gate.js';
import type { RemoteEventBatch } from '../activity-outbox.js';
import { noteGateAdmitted, setManagedAdmissionListener } from '../ingress-mark.js';
import {
  ACTIVITY_REPORT_INTERVAL_MS,
  ManagedActivity,
  isPassiveRead,
} from '../managed-activity.js';
import type {
  ManagedClosedEvent,
  ManagedCloseOptions,
  ManagedPhase,
} from '../managed-forwarding.js';
import { createManagedIngress, type ManagedIngress } from '../managed-ingress.js';

const PROOF = { header: 'x-dorkos-edge', secret: 's'.repeat(48) };
const HOST = 'abc.remote.example';
const INSTANCE = 'inst_0001';

/** Timers the test runs by hand, against a clock it moves. */
function clock() {
  let now = Date.parse('2026-10-10T12:00:00.000Z');
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  return {
    now: () => now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const handle = ++next;
        pending.set(handle, { at: now + ms, fn });
        return handle;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    },
    /** Move the clock, running every timer that comes due, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    get pending() {
      return pending.size;
    },
  };
}

/** A tunnel that records closes and can announce a session's end. */
function fakeTunnel() {
  const events = new EventEmitter();
  const tunnel = {
    phase: 'open' as ManagedPhase | null,
    getManagedPhase: () => tunnel.phase,
    closeManaged: vi.fn(async (options: ManagedCloseOptions) => {
      tunnel.phase = null;
      events.emit('managed_closed', {
        generation: 1,
        reason: options.reason ?? 'closed',
        at: new Date(0).toISOString(),
      } satisfies ManagedClosedEvent);
    }),
    on: (event: 'managed_closed', listener: (event: ManagedClosedEvent) => void) =>
      events.on(event, listener),
    end: (reason: string, at = '2026-10-10T13:00:00.000Z') =>
      events.emit('managed_closed', { generation: 1, reason, at }),
  };
  return tunnel;
}

function world() {
  const time = clock();
  const tunnel = fakeTunnel();
  const reported: RemoteEventBatch[] = [];
  const activity = new ManagedActivity({
    tunnel,
    report: (batch) => reported.push(batch),
    now: time.now,
    timers: time.timers,
    random: () => 0.5,
  });
  return { time, tunnel, reported, activity };
}

function request(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function response(): ServerResponse & { finish: () => void } {
  const emitter = new EventEmitter() as unknown as ServerResponse & { finish: () => void };
  emitter.finish = () => emitter.emit('close');
  return emitter;
}

describe('isPassiveRead', () => {
  it('is a background read, never a change or a page load', () => {
    expect(isPassiveRead(request('GET'))).toBe(true);
    expect(isPassiveRead(request('HEAD'))).toBe(true);
    expect(isPassiveRead(request('GET', { 'sec-fetch-mode': 'navigate' }))).toBe(false);
    expect(isPassiveRead(request('POST'))).toBe(false);
    expect(isPassiveRead(request('DELETE'))).toBe(false);
  });
});

describe('counting through the real ingress and gate', () => {
  let ingress: ManagedIngress;
  let port: number;
  let tmpDir: string;
  const counted: string[] = [];

  /** Write one raw request and resolve with its status once the server closes. */
  function send(lines: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('error', reject);
      socket.on('close', () => resolve(Number(data.split(' ')[1])));
      socket.write([...lines, 'Connection: close', '', ''].join('\r\n'));
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-managed-activity-'));
    // Login off: the real session gate lets everything through, and says so.
    initConfigManager(tmpDir);
    counted.length = 0;
    setManagedAdmissionListener((req) => counted.push(`${req.method} ${req.url}`));
    const app = express();
    // A stand-in for a login the request does not have: refused before the gate admits.
    app.use((req, res, next) => {
      if (req.headers['x-test-signed-out']) return void res.status(401).end();
      next();
    });
    app.use(sessionGate);
    // A second pass through the hook (the Hono chain, say) never counts twice.
    app.use((req, res, next) => {
      noteGateAdmitted(req, res);
      next();
    });
    app.use((_req, res) => res.status(200).json({ ok: true }));
    ingress = createManagedIngress({
      handler: app,
      forwardUpgrade: (_r, socket) => socket.destroy(),
    });
    const url = await ingress.open();
    port = Number(new URL(url).port);
    ingress.setHosts([HOST]);
    ingress.setEdgeProof(PROOF);
  });

  afterEach(async () => {
    setManagedAdmissionListener(null);
    await ingress.close({ immediate: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const good = [`Host: ${HOST}`, `X-DorkOS-Edge: ${PROOF.secret}`];

  it('counts an admitted request once, and never a refused attempt', async () => {
    expect(await send(['GET /api/sessions HTTP/1.1', ...good])).toBe(200);
    expect(await send(['GET /api/a HTTP/1.1', `Host: ${HOST}`])).toBe(403);
    expect(await send(['GET /api/b HTTP/1.1', `Host: ${HOST}`, 'X-DorkOS-Edge: wrong'])).toBe(403);
    expect(
      await send([
        'GET /api/c HTTP/1.1',
        ...good,
        `X-DorkOS-Edge: ${PROOF.secret}`, // two copies
      ])
    ).toBe(403);
    expect(await send(['GET /api/d HTTP/1.1', 'Host: other.example', good[1]!])).toBe(421);
    expect(await send(['POST /api/e HTTP/1.1', ...good, 'X-Test-Signed-Out: 1'])).toBe(401);
    expect(counted).toEqual(['GET /api/sessions']);
  });

  it('counts nothing that did not arrive through the managed ingress', () => {
    noteGateAdmitted(request('GET'), response());
    expect(counted).toEqual([]);
  });
});

describe('the activity window', () => {
  it('reports a span on close: when it opened, why it closed, the wake and the requests', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1' });
    w.time.advance(60_000);
    w.activity.admitted(request('POST'), response());
    w.activity.admitted(request('GET'), response());
    w.tunnel.end('closed_by_cloud', '2026-10-10T12:05:00.000Z');
    expect(w.reported).toEqual([
      {
        instanceId: INSTANCE,
        activity: [{ at: '2026-10-10T12:05:00.000Z', requests: 2 }],
        closeReports: [
          {
            at: '2026-10-10T12:05:00.000Z',
            reason: 'closed_by_cloud',
            wakeId: 'wk_1',
            openedAt: '2026-10-10T12:00:00.000Z',
            requests: 2,
          },
        ],
      },
    ]);
    // Bytes are not measured here, so none are claimed.
    expect(w.reported[0]!.closeReports[0]).not.toHaveProperty('bytesIn');
    expect(w.reported[0]!.closeReports[0]).not.toHaveProperty('bytesOut');
    expect(w.time.pending).toBe(0);
  });

  it('sends a running count on its beat only when it moved', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1' });
    w.time.advance(ACTIVITY_REPORT_INTERVAL_MS);
    expect(w.reported).toHaveLength(0);
    w.activity.admitted(request('GET'), response());
    w.time.advance(ACTIVITY_REPORT_INTERVAL_MS);
    expect(w.reported).toEqual([
      {
        instanceId: INSTANCE,
        activity: [{ at: expect.any(String), requests: 1 }],
        closeReports: [],
      },
    ]);
  });

  it('a repeated open keeps the span and takes the newer windows', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1', idleWindowSeconds: 60 });
    w.activity.admitted(request('POST'), response());
    w.time.advance(30_000);
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_2', idleWindowSeconds: 600 });
    w.time.advance(120_000);
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
    w.tunnel.end('closed_here');
    expect(w.reported[0]!.closeReports[0]).toMatchObject({
      wakeId: 'wk_1',
      openedAt: '2026-10-10T12:00:00.000Z',
      requests: 1,
    });
  });

  it('counts nothing when no window is open', () => {
    const w = world();
    w.activity.admitted(request('POST'), response());
    w.tunnel.end('closed');
    expect(w.reported).toHaveLength(0);
  });
});

describe('idle close', () => {
  it('closes gently after the window Cloud gave, under its drain deadline, as idle', () => {
    const w = world();
    w.activity.opened({
      instanceId: INSTANCE,
      wakeId: 'wk_1',
      idleWindowSeconds: 900,
      drainDeadlineSeconds: 20,
    });
    w.time.advance(899_000);
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
    w.time.advance(1_000);
    expect(w.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: 20_000,
      reason: 'idle',
    });
    expect(w.reported[0]!.closeReports[0]!.reason).toBe('idle');
  });

  it('leaves the local default deadline to the ingress when Cloud named none', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1', idleWindowSeconds: 60 });
    w.time.advance(60_000);
    expect(w.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: undefined,
      reason: 'idle',
    });
  });

  it('activity holds it off; background reads do not', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1', idleWindowSeconds: 60 });
    w.time.advance(50_000);
    const res = response();
    w.activity.admitted(request('POST'), res);
    w.time.advance(30_000);
    res.finish(); // the request's end is activity too
    w.time.advance(59_000);
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
    // An open tab polling on its own keeps nothing open.
    for (let i = 0; i < 6; i += 1) {
      w.activity.admitted(request('GET'), response());
      w.time.advance(500);
    }
    expect(w.tunnel.closeManaged).toHaveBeenCalledTimes(1);
  });

  it('never fires without a window from Cloud', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1' });
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1', idleWindowSeconds: 0 });
    w.time.advance(24 * 60 * 60_000);
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
  });

  it.each(['withdrawn', 'mode_change', 'closed_by_cloud', 'shutdown', 'revoked'])(
    'is cancelled when the session ends first (%s)',
    (reason) => {
      const w = world();
      w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1', idleWindowSeconds: 60 });
      w.tunnel.end(reason);
      expect(w.time.pending).toBe(0);
      w.time.advance(10 * 60_000);
      expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
      expect(w.reported).toHaveLength(1);
      expect(w.reported[0]!.closeReports[0]!.reason).toBe(reason);
    }
  );

  it('does nothing when the session is no longer open when it comes due', () => {
    const w = world();
    w.activity.opened({ instanceId: INSTANCE, wakeId: 'wk_1', idleWindowSeconds: 60 });
    w.tunnel.phase = 'draining';
    w.time.advance(60_000);
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
  });
});
