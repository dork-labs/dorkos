/** Genuine agent-token HTTP caller retirement while the original operator view survives a queued timer. */
import express from 'express';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { canvasDocEvents, canvasDocBatches, eq } from '@dorkos/db';
import router from '../../../../../routes/canvas-doc-events.js';
import {
  resolveAgentIdentity,
  AGENT_IDENTITY_HEADER,
} from '../../../../../middleware/agent-identity.js';
import {
  initAgentIdentityService,
  getAgentIdentityService,
  resetAgentIdentityService,
} from '../../../../core/agent-identity/index.js';
import {
  setRoomService,
  getRoomService,
  clearRoomService,
  type RoomService,
} from '../../../../rooms/index.js';
import { nativeRoomAuthorityFixture } from './authority-fixtures.js';

const target = swappableServer();

it('uses the committed surviving HTTP operator after an actual revoked agent caller and timer held behind native SQL', async () => {
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let identity: ReturnType<typeof initAgentIdentityService> | undefined;
  let previousRoom: RoomService | undefined;
  let roomInstalled = false,
    ownersClosed = false,
    failed = false,
    first: unknown;
  let agentPath: string | undefined;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const actualNow = Date.now.bind(Date);
  let advance = 0;
  let restoreClock: (() => void) | undefined;
  let restoreIso: (() => void) | undefined;
  let timerArmed = false,
    timerFired = 0;
  const originalIso = Date.prototype.toISOString;
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(Date, 'now');
    restoreClock = clock.mockRestore.bind(clock);
    clock.mockImplementation(() => actualNow() + advance);
    const iso = vi.spyOn(Date.prototype, 'toISOString');
    restoreIso = iso.mockRestore.bind(iso);
    iso.mockImplementation(function (this: Date) {
      if (timerArmed && h?.db.$client.inTransaction) {
        timerArmed = false;
        timerFired++;
        expect(h.db.$client.inTransaction).toBe(true);
        advance = 75_000;
        // Observe the actual native transition clock serialization; no opaque SQL callback.
        vi.advanceTimersByTime(75_000);
      }
      return originalIso.call(this);
    });
    // This test owns its normal boot binding; never replace a foreign identity service.
    if (getAgentIdentityService())
      throw new Error('Original agent identity bootstrap is already owned');
    try {
      previousRoom = getRoomService();
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== 'RoomService not initialized') throw cause;
    }
    agentPath = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'presence-http-survivor-')));
    h = await nativeRoomAuthorityFixture(agentPath, 'claude-code', randomUUID(), randomUUID());
    const own = h;
    setRoomService(own.rooms.service);
    roomInstalled = true;
    identity = initAgentIdentityService(own.db);
    const token = await identity.mint({
      agentPath: own.originalTarget.agentPath,
      displayName: 'Original presence agent',
    });
    const app = express();
    app.use(express.json());
    app.use(resolveAgentIdentity);
    // The actual original actor resolver consumes middleware identity and captures
    // the same native token digest privately. No supplied principal/actor callback.
    app.locals.docChannelHttp = own.http;
    app.use('/docs', router);
    const server = target.mount(app),
      path = `/docs/${own.documentId}/presence`;
    const rows = () =>
      own.db
        .select()
        .from(canvasDocEvents)
        .where(eq(canvasDocEvents.documentId, own.documentId))
        .all();
    const firstView = await request(server).post(path).send({ action: 'mount' });
    const survivor = await request(server).post(path).send({ action: 'mount' });
    const mountId = randomUUID();
    const agentView = await request(server)
      .post(path)
      .set(AGENT_IDENTITY_HEADER, token)
      .send({ action: 'mount', mountId });
    expect(firstView.status).toBe(200);
    expect(survivor.status).toBe(200);
    expect(agentView.status).toBe(200);
    expect(agentView.body.views).toBe(3);
    expect(agentView.body.viewerId).not.toBe(survivor.body.viewerId);
    expect(rows().map((row) => [row.type, row.payload])).toEqual([
      ['host.opened', { mounts: 1 }],
      ['doc.viewers', { views: 1 }],
      ['host.opened', { mounts: 1 }],
      ['doc.viewers', { views: 2 }],
      ['host.opened', { mounts: 1 }],
      ['doc.viewers', { views: 3 }],
    ]);
    advance = 74_000;
    const beat = await request(server)
      .post(path)
      .send({ action: 'heartbeat', viewerId: survivor.body.viewerId });
    expect(beat.status).toBe(200);
    expect(beat.body.views).toBe(3);
    // Same logical agent mount does not renew its TTL, but genuinely makes the
    // current context's last actor the agent before its original token retirement.
    const retry = await request(server)
      .post(path)
      .set(AGENT_IDENTITY_HEADER, token)
      .send({ action: 'mount', mountId });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(agentView.body);
    expect(rows()).toHaveLength(6);
    expect(await identity.revoke(own.originalTarget.agentPath)).toBe(1);
    timerArmed = true;
    const leave = await request(server)
      .post(path)
      .send({ action: 'unmount', viewerId: firstView.body.viewerId });
    expect(leave.status).toBe(200);
    expect(leave.body.views).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(timerFired).toBe(1);
    expect(rows().filter((row) => row.type === 'host.closed')).toHaveLength(2);
    expect(
      rows()
        .slice(6)
        .map((row) => [row.type, row.payload])
    ).toEqual([
      ['host.closed', { mounts: 1 }],
      ['doc.viewers', { views: 2 }],
      ['host.closed', { mounts: 1 }],
      ['doc.viewers', { views: 1 }],
    ]);
    const before = rows();
    const alive = await request(server)
      .post(path)
      .send({ action: 'heartbeat', viewerId: survivor.body.viewerId });
    expect(alive.status).toBe(200);
    expect(alive.body.views).toBe(1);
    expect(rows()).toEqual(before);
    const next = await request(server).post(path).send({ action: 'mount' });
    expect(next.status).toBe(200);
    expect(next.body.views).toBe(2);
    expect(
      own.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.documentId, own.documentId))
        .all()
    ).toEqual([]);
  } catch (cause) {
    remember(cause);
  }
  // Positive native stop is mandatory before resetting original bootstrap bindings
  // or deleting its files. Every independent restoration preserves the first raw cause.
  if (h) {
    try {
      await h.cleanup();
      ownersClosed = true;
    } catch (cause) {
      // Diagnostic DATA only: preserve the earlier assertion/raw cause and UNKNOWN ownership.
      const earlierFailure = failed;
      remember(cause);
      if (earlierFailure) {
        try {
          const message =
            cause instanceof Error
              ? Object.getOwnPropertyDescriptor(cause, 'message')?.value
              : undefined;
          const reason =
            typeof message === 'string' && /^[A-Za-z0-9 .:_-]{1,256}$/.test(message)
              ? message
              : cause === undefined
                ? 'raw undefined'
                : typeof cause;
          process.stderr.write(
            'ORIGINAL_PRESENCE_SURVIVOR_STOP_CAUSE ' + JSON.stringify({ reason }) + '\n'
          );
        } catch (diagnosticCause) {
          remember(diagnosticCause);
        }
      }
    }
  }
  if (ownersClosed && h) {
    if (identity) {
      try {
        if (getAgentIdentityService() !== identity)
          throw new Error('Original identity bootstrap was replaced');
        resetAgentIdentityService();
      } catch (cause) {
        remember(cause);
      }
    }
    if (roomInstalled) {
      try {
        if (!clearRoomService(h.rooms.service))
          throw new Error('Original Room bootstrap was replaced');
        if (previousRoom) setRoomService(previousRoom);
      } catch (cause) {
        remember(cause);
      }
    }
    if (agentPath) {
      try {
        await fs.rm(agentPath, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
    }
  }
  try {
    restoreIso?.();
  } catch (cause) {
    remember(cause);
  }
  try {
    restoreClock?.();
  } catch (cause) {
    remember(cause);
  }
  try {
    vi.useRealTimers();
  } catch (cause) {
    remember(cause);
  }
  if (failed) throw first;
});
