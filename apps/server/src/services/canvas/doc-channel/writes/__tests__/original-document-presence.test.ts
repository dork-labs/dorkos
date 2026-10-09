import express from 'express';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { canvasDocEvents, canvasDocBatches, canvasDocuments, eq } from '@dorkos/db';
import router from '../../../../../routes/canvas-doc-events.js';
import { resolveOperatorAuthor } from '../../../../rooms/index.js';
import { nativeRoomAuthorityFixture } from './authority-fixtures.js';

const target = swappableServer();
/** The route receives the actual constructor-issued operator, never a principal DTO. */
async function ownedPresence() {
  const agentPath = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'presence-agent-')));
  const h = await nativeRoomAuthorityFixture(agentPath, 'claude-code', randomUUID(), randomUUID());
  try {
    const app = express();
    app.use(express.json());
    app.locals.docChannelHttp = { service: h.http.service, actor: () => h.operator };
    app.use('/docs', router);
    const server = target.mount(app);
    const rows = () =>
      h.db.select().from(canvasDocEvents).where(eq(canvasDocEvents.documentId, h.documentId)).all();
    return {
      h,
      server,
      rows,
      path: `/docs/${h.documentId}/presence`,
      async close() {
        await h.cleanup();
        await fs.rm(agentPath, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    // Original fixture construction owns its own partial-failure drains. Once it
    // returned, this setup owns it too; failed native cleanup retains its Db/root.
    try {
      await h.cleanup();
      await fs.rm(agentPath, { recursive: true, force: true });
    } catch {
      /* The original setup cause stays first; unresolved resources remain owned. */
    }
    throw cause;
  }
}

/** Retain first raw failure while independently attempting original cleanup and every restoration. */
async function originalPresenceCase(
  body: (own: Awaited<ReturnType<typeof ownedPresence>>) => Promise<void>,
  restore: readonly (() => void)[] = []
): Promise<void> {
  let own: Awaited<ReturnType<typeof ownedPresence>> | undefined;
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    own = await ownedPresence();
    await body(own);
  } catch (cause) {
    remember(cause);
  }
  // The fixture retains Db/root when native owner stop is UNKNOWN; never force-close it here.
  if (own) {
    try {
      await own.close();
    } catch (cause) {
      remember(cause);
    }
  }
  for (const retire of restore) {
    try {
      retire();
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
}

describe('original native per-document mount presence', () => {
  it('counts distinct views by the same operator, keeps beats quiet, and produces no agent batches', async () => {
    await originalPresenceCase(async (own) => {
      const mountId = randomUUID();
      const first = await request(own.server).post(own.path).send({ action: 'mount', mountId });
      const retry = await request(own.server).post(own.path).send({ action: 'mount', mountId });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(own.rows()).toHaveLength(2);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ views: 1, heartbeatMs: 30000, ttlMs: 75000 });
      const second = await request(own.server).post(own.path).send({ action: 'mount' });
      expect(second.status).toBe(200);
      expect(second.body.views).toBe(2);
      expect(second.body.viewerId).not.toBe(first.body.viewerId);
      const before = own.rows();
      expect(before.map((row) => row.type)).toEqual([
        'host.opened',
        'doc.viewers',
        'host.opened',
        'doc.viewers',
      ]);
      // Genuine nonempty HTTP replay must be admissible by the strict original client guard.
      const replay = await request(own.server).get(`/docs/${own.h.documentId}/channel`);
      expect(replay.status).toBe(200);
      expect(replay.body.incarnation.documentId).toBe(own.h.documentId);
      expect(
        replay.body.events.map((frame: { event: { type: string } }) => frame.event.type)
      ).toEqual(before.map((row) => row.type));
      for (const frame of replay.body.events) {
        expect(frame.documentId).toBe(own.h.documentId);
        expect(frame.incarnation).toEqual(replay.body.incarnation);
      }
      const nextPage = await request(own.server).get(
        `/docs/${own.h.documentId}/channel?since=2&limit=1`
      );
      expect(nextPage.status).toBe(200);
      expect(nextPage.body.events).toHaveLength(1);
      expect(nextPage.body.events[0].docSeq).toBe(3);
      expect(nextPage.body.events[0].incarnation).toEqual(replay.body.incarnation);
      for (const row of before) {
        expect(row.direction).toBe('system');
        expect(row.provenance).toEqual({ source: 'doc-channel-presence' });
        expect(JSON.stringify(row.payload)).not.toContain(first.body.viewerId);
        expect(JSON.stringify(row.payload)).not.toContain(second.body.viewerId);
      }
      for (let n = 0; n < 2; n++) {
        const beat = await request(own.server)
          .post(own.path)
          .send({ action: 'heartbeat', viewerId: first.body.viewerId });
        expect(beat.status).toBe(200);
        expect(beat.body.views).toBe(2);
      }
      expect(own.rows()).toEqual(before);
      const foreign = await request(own.server)
        .post(own.path)
        .send({ action: 'unmount', viewerId: randomUUID() });
      expect(foreign.status).toBe(404);
      expect(own.rows()).toEqual(before);
      const leave = await request(own.server)
        .post(own.path)
        .send({ action: 'unmount', viewerId: second.body.viewerId });
      expect(leave.status).toBe(200);
      expect(leave.body.views).toBe(1);
      expect(
        own
          .rows()
          .slice(4)
          .map((row) => [row.type, row.payload])
      ).toEqual([
        ['host.closed', { mounts: 1 }],
        ['doc.viewers', { views: 1 }],
      ]);
      expect(
        own.h.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, own.h.documentId))
          .all()
      ).toEqual([]);
    });
  });
  it('rolls back native event failure without committing a ghost mount', async () => {
    await originalPresenceCase(async (own) => {
      own.h.db.$client.exec(
        "CREATE TEMP TRIGGER reject_presence BEFORE INSERT ON canvas_doc_events WHEN NEW.type='host.opened' BEGIN SELECT RAISE(ABORT,'original presence INSERT refused'); END"
      );
      const refused = await request(own.server).post(own.path).send({ action: 'mount' });
      expect(refused.status).toBe(500);
      expect(own.rows()).toEqual([]);
      own.h.db.$client.exec('DROP TRIGGER reject_presence');
      const first = await request(own.server).post(own.path).send({ action: 'mount' });
      expect(first.status).toBe(200);
      expect(first.body.views).toBe(1);
    });
  });
  it('expires original mounts at the exact clock boundary and refuses the old issued viewer', async () => {
    const actualNow = Date.now.bind(Date);
    let advance = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + advance);
    await originalPresenceCase(
      async (own) => {
        const first = await request(own.server).post(own.path).send({ action: 'mount' });
        expect(first.status).toBe(200);
        advance = 75000;
        const expired = await request(own.server)
          .post(own.path)
          .send({ action: 'heartbeat', viewerId: first.body.viewerId });
        expect(expired.status).toBe(404);
        const fresh = await request(own.server).post(own.path).send({ action: 'mount' });
        expect(fresh.status).toBe(200);
        expect(fresh.body.views).toBe(1);
        expect(fresh.body.viewerId).not.toBe(first.body.viewerId);
        expect(
          own
            .rows()
            .slice(2)
            .map((row) => row.type)
        ).toEqual(['host.closed', 'host.opened']);
        // Replacing one expired mount with one real mount leaves the count unchanged.
        expect(own.rows().filter((row) => row.type === 'doc.viewers')).toHaveLength(1);
      },
      [() => clock.mockRestore()]
    );
  });
  it('keeps actual focus log-only until exact operator approval, while count changes never create a batch', async () => {
    const actualNow = Date.now.bind(Date);
    let advance = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + advance);
    await originalPresenceCase(
      async (own) => {
        const fixture = own;
        fixture.h.http.grants.configure(
          fixture.h.documentId,
          {
            routes: [
              {
                id: 'native-focus',
                on: 'host.focus',
                to: 'room:self',
                turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 2 },
              },
            ],
          },
          fixture.h.operator,
          fixture.h.originalTarget.agentId
        );
        const mounted = await request(fixture.server).post(fixture.path).send({ action: 'mount' });
        expect(mounted.status).toBe(200);
        const focus = (focused: boolean) =>
          request(fixture.server)
            .post(fixture.path)
            .send({ action: 'focus', viewerId: mounted.body.viewerId, focused });
        const first = await focus(true);
        expect(first.status).toBe(200);
        expect(fixture.rows().filter((row) => row.type === 'host.focus')).toHaveLength(1);
        const batches = () =>
          fixture.h.db
            .select()
            .from(canvasDocBatches)
            .where(eq(canvasDocBatches.documentId, fixture.h.documentId))
            .all();
        expect(batches()).toEqual([]);
        const before = fixture.rows();
        const burst = await focus(false);
        expect(burst.status).toBe(200);
        expect(fixture.rows()).toEqual(before);
        const grantRequest = {
          documentId: fixture.h.documentId,
          routeId: 'native-focus',
          expiresAt: new Date(actualNow() + 3600000).toISOString(),
        };
        const pending = fixture.h.http.grants.grant(grantRequest, fixture.h.operator);
        expect(pending.kind).toBe('approval_required');
        if (pending.kind !== 'approval_required')
          throw new Error('Original focus approval missing');
        fixture.h.approvals.grant(pending.ticket.approvalId);
        const granted = fixture.h.http.grants.grant(
          grantRequest,
          fixture.h.operator,
          pending.ticket.token
        );
        expect(granted.kind).toBe('granted');
        if (granted.kind !== 'granted') throw new Error('Original focus grant missing');
        advance = 500;
        const next = await focus(false);
        expect(next.status).toBe(200);
        const logged = fixture.rows().filter((row) => row.type === 'host.focus');
        expect(logged.map((row) => row.payload)).toEqual([{ focused: true }, { focused: false }]);
        expect(batches()).toHaveLength(1);
        expect(batches()[0]).toMatchObject({
          routeId: 'native-focus',
          grantId: granted.grant.grantId,
          inputEventIds: [logged[1].eventId],
          status: 'pending',
        });
        const duplicate = await focus(false);
        expect(duplicate.status).toBe(200);
        expect(fixture.rows().filter((row) => row.type === 'host.focus')).toEqual(logged);
        expect(batches()).toHaveLength(1);
        const untouched = await request(fixture.server)
          .post(fixture.path)
          .send({ action: 'heartbeat', viewerId: mounted.body.viewerId });
        expect(untouched.status).toBe(200);
        expect(batches()).toHaveLength(1);
        // Pending native delivery is not a claimed SDK FIRST; no paid runtime is invoked here.
      },
      [() => clock.mockRestore()]
    );
  });

  it('retires an actually closed original source before expiry without poisoning a later native document', async () => {
    const actualNow = Date.now.bind(Date);
    let advance = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + advance);
    await originalPresenceCase(
      async (own) => {
        const mounted = await request(own.server).post(own.path).send({ action: 'mount' });
        expect(mounted.status).toBe(200);
        const physical = own.h.db
          .select()
          .from(canvasDocuments)
          .where(eq(canvasDocuments.id, own.h.documentId))
          .get();
        if (!physical) throw new Error('Original presence document missing before closure');
        // Actual original lifecycle closes/revokes and retains the tombstone; no hand-written closure row.
        expect(own.h.rooms.canvasDocuments.remove(physical.scope, physical.id)).toBe(true);
        advance = 75000;
        await vi.advanceTimersByTimeAsync(75000);
        const author = resolveOperatorAuthor(own.h.rooms.authors);
        const next = own.h.rooms.canvas.open(
          'room:' + own.h.roomId,
          author.id,
          { type: 'markdown', content: 'Another original visible source' },
          {
            tree: {
              resolvedCwd: own.h.originalTarget.agentPath,
              treeKind: 'agent-cwd',
              sourceLabel: null,
              aheadOfMain: null,
            },
          }
        );
        const fresh = await request(own.server)
          .post(`/docs/${next.id}/presence`)
          .send({ action: 'mount' });
        expect(fresh.status).toBe(200);
        expect(fresh.body.views).toBe(1);
        expect(fresh.body.viewerId).not.toBe(mounted.body.viewerId);
        const old = await request(own.server)
          .post(own.path)
          .send({ action: 'heartbeat', viewerId: mounted.body.viewerId });
        expect(old.status).toBe(404);
        // Positive owning cleanup below proves the known closure did not latch an UNKNOWN failure.
      },
      [() => clock.mockRestore(), () => vi.useRealTimers()]
    );
  });

  it('publishes an actual zero count when the last native caller leaves a still-live source', async () => {
    const actualNow = Date.now.bind(Date);
    let advance = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + advance);
    await originalPresenceCase(
      async (own) => {
        const mounted = await request(own.server).post(own.path).send({ action: 'mount' });
        expect(mounted.status).toBe(200);
        const human = resolveOperatorAuthor(own.h.rooms.authors);
        // Real operator membership mutation; neither an invalid actor nor hand-written retirement row.
        own.h.rooms.service.removeMember(own.h.roomId, human.id, human.id);
        advance = 75_000;
        await vi.advanceTimersByTimeAsync(75_000);
        expect(own.rows().map((row) => [row.type, row.payload])).toEqual([
          ['host.opened', { mounts: 1 }],
          ['doc.viewers', { views: 1 }],
          ['host.closed', { mounts: 1 }],
          ['doc.viewers', { views: 0 }],
        ]);
        expect(
          own.h.db
            .select()
            .from(canvasDocuments)
            .where(eq(canvasDocuments.id, own.h.documentId))
            .get()
        ).toBeDefined();
        expect(own.h.http.channels.getChannel(own.h.documentId)?.closedAt).toBeNull();
        expect(
          own.h.db
            .select()
            .from(canvasDocBatches)
            .where(eq(canvasDocBatches.documentId, own.h.documentId))
            .all()
        ).toEqual([]);
        // A subsequent actual document can mount; known member retirement did not poison shutdown or other sources.
        const next = own.h.rooms.canvas.open(
          'session:' + own.h.originalTarget.canonicalSessionId,
          human.id,
          { type: 'markdown', content: 'Original new host source' },
          {
            tree: {
              resolvedCwd: own.h.originalTarget.agentPath,
              treeKind: 'agent-cwd',
              sourceLabel: null,
              aheadOfMain: null,
            },
          }
        );
        const fresh = await request(own.server)
          .post(`/docs/${next.id}/presence`)
          .send({ action: 'mount' });
        expect(fresh.status).toBe(200);
        expect(fresh.body.views).toBe(1);
      },
      [() => clock.mockRestore(), () => vi.useRealTimers()]
    );
  });

  it('joins the actual timer queued during a held original last-unmount transaction without poisoning retirement', async () => {
    const actualNow = Date.now.bind(Date);
    let advance = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + advance);
    await originalPresenceCase(
      async (own) => {
        const fixture = own;
        const mounted = await request(own.server).post(own.path).send({ action: 'mount' });
        expect(mounted.status).toBe(200);
        let fired = 0;
        own.h.db.$client.function('original_presence_fire_due_timer', () => {
          if (++fired !== 1) throw new Error('Original timer trigger unexpectedly repeated');
          expect(fixture.h.db.$client.inTransaction).toBe(true);
          advance = 75_000;
          // Real original timer callback fires while the first original operation owns SQL;
          // it must wait for that operation, then reread the actual committed private context.
          vi.advanceTimersByTime(75_000);
          return null;
        });
        own.h.db.$client.exec(
          "CREATE TEMP TRIGGER original_presence_held_unmount BEFORE INSERT ON canvas_doc_events WHEN NEW.type='host.closed' BEGIN SELECT original_presence_fire_due_timer(); END"
        );
        const leave = await request(own.server)
          .post(own.path)
          .send({ action: 'unmount', viewerId: mounted.body.viewerId });
        expect(leave.status).toBe(200);
        expect(leave.body.views).toBe(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(fired).toBe(1);
        expect(own.rows().map((row) => [row.type, row.payload])).toEqual([
          ['host.opened', { mounts: 1 }],
          ['doc.viewers', { views: 1 }],
          ['host.closed', { mounts: 1 }],
          ['doc.viewers', { views: 0 }],
        ]);
        own.h.db.$client.exec('DROP TRIGGER original_presence_held_unmount');
        const next = await request(own.server).post(own.path).send({ action: 'mount' });
        expect(next.status).toBe(200);
        expect(next.body.views).toBe(1);
        // Positive native owning cleanup joins queued timer work and would retain the root on UNKNOWN.
      },
      [() => clock.mockRestore(), () => vi.useRealTimers()]
    );
  });
});
