/**
 * @vitest-environment node
 *
 * `resolveCaller` end to end, over the real router, a real Better Auth instance
 * and a real SQLite file (spec `invites` §4.2–§4.3, ADR 260727-184933 D6).
 *
 * This is the seam the owner's whole identity hangs off, and the property it has
 * to hold is continuity: **one person, one author id, for the life of the
 * install**, across every posture the login toggle can put it in. Rooms,
 * memberships and read cursors all key on that id, so a second author minted
 * anywhere along the way is not a cosmetic bug — it is the owner opening the
 * cockpit to an empty sidebar.
 *
 * Four phases, in the order a real install lives them:
 *
 * 1. **Login off, no account.** The default posture. Rooms get made and read.
 * 2. **The owner registers**, which is what the enable-login flow does.
 * 3. **Login on**, owner signed in — branch 2, through `bindOwner`.
 * 4. **Login off again**, no cookie — branch 3 with an owner present. The spec's
 *    sketch mints `localHuman()` here, which strands everything from phase 1.
 *
 * Driven through supertest against the real `/api/rooms` router rather than by
 * calling `resolveCaller` directly, because the thing under test is a seam: what
 * `sessionGate` puts on `res.locals` and what the handler then resolves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import roomRoutes from '../rooms.js';
import readCursorRoutes from '../read-cursors.js';
import { getAuth, initAuth, sessionGate, toNodeHandler } from '../../services/core/auth/index.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';

/** An app in `app.ts`'s middleware order, mounting only the rooms surface. */
function buildApp(): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionGate);
  app.use('/api/rooms', roomRoutes);
  // Mounted because a read cursor is not a room route: `/api/read-cursors` is
  // the one write path onto read state, and this test's whole subject is that
  // the SAME author id carries across it and `/api/rooms` alike.
  app.use('/api/read-cursors', readCursorRoutes);
  return app;
}

// Emails are assembled from parts so the source never contains a literal address.
const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** Flip the runtime `auth.enabled` flag the session gate reads per request. */
function setAuthEnabled(enabled: boolean): void {
  configManager.set('auth', { enabled });
}

describe('resolveCaller — one owner, one author id, across every login posture', () => {
  let tmpDir: string;
  let db: Db;
  let app: express.Express;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-caller-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'caller-test.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    app = buildApp();
  });

  afterAll(() => {
    setAuthEnabled(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('carries the owner, their rooms and their cursor through all four phases', async () => {
    // ---- Phase 1: login off, nobody registered ----
    setAuthEnabled(false);

    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend' });
    expect(created.status).toBe(201);
    const roomId = created.body.id as string;
    const authorId = created.body.viewerAuthorId as string;
    expect(authorId).toEqual(expect.any(String));
    // The unbound sentinel renders as "You" — nobody else is here to disambiguate.
    expect(created.body.members[0].author.displayName).toBe('You');

    const posted = await request(app)
      .post(`/api/rooms/${roomId}/entries`)
      .send({ text: 'said before there were accounts' });
    expect(posted.status).toBe(202);
    const seq = posted.body.seq as number;

    expect(
      (await request(app).put(`/api/read-cursors/room/${roomId}`).send({ lastReadSeq: seq })).status
    ).toBe(200);

    // ---- Phase 2: the owner registers (the enable-login flow) ----
    const signUp = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Dorian' });
    expect(signUp.status).toBe(200);
    const ownerUserId = db.select().from(user).get()!.id;

    const signIn = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(signIn.status).toBe(200);
    const cookies = signIn.headers['set-cookie'] as unknown as string[];

    // ---- Phase 3: login on, owner signed in (branch 2 → bindOwner) ----
    setAuthEnabled(true);

    const signedIn = await request(app).get(`/api/rooms/${roomId}`).set('Cookie', cookies);
    expect(signedIn.status).toBe(200);
    // The rebind, observed from outside: same author, now bound to the account.
    expect(signedIn.body.viewerAuthorId).toBe(authorId);
    const membership = signedIn.body.members.find(
      (m: { authorId: string }) => m.authorId === authorId
    );
    expect(membership.lastReadSeq).toBe(seq);
    // Still "You". The account name must not reach the roster: one name column
    // per author means writing it would relabel the phase-1 message too.
    expect(membership.author.displayName).toBe('You');
    expect(membership.author.displayName).not.toBe('Dorian');

    const listedSignedIn = await request(app).get('/api/rooms').set('Cookie', cookies);
    expect(listedSignedIn.body.rooms.map((r: { id: string }) => r.id)).toEqual([roomId]);
    // The natural key moved even though nothing else did — the rebind happened.
    expect(readNaturalKey(db, authorId)).toBe(`user:${ownerUserId}`);

    // ---- Phase 4: login off again (branch 3, with an owner present) ----
    // The spec's sketch calls `localHuman()` here. That mints a SECOND author,
    // because the sentinel's natural key is now the account's — and the owner
    // opens the cockpit to an empty sidebar, holding no cursor and no membership.
    setAuthEnabled(false);

    const loggedOut = await request(app).get(`/api/rooms/${roomId}`);
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.body.viewerAuthorId).toBe(authorId);
    expect(
      loggedOut.body.members.find((m: { authorId: string }) => m.authorId === authorId).lastReadSeq
    ).toBe(seq);

    const listedLoggedOut = await request(app).get('/api/rooms');
    expect(listedLoggedOut.body.rooms.map((r: { id: string }) => r.id)).toEqual([roomId]);

    // And no stray author was left anywhere along the way.
    expect(countHumanAuthors(db)).toBe(1);

    // ---- And back on again, for good measure ----
    setAuthEnabled(true);
    const backOn = await request(app).get(`/api/rooms/${roomId}`).set('Cookie', cookies);
    expect(backOn.body.viewerAuthorId).toBe(authorId);
    expect(countHumanAuthors(db)).toBe(1);
  });

  it('refuses a request carrying no credential at all once login is on', async () => {
    // The precondition every branch above rests on: with login on, branch 3 is
    // not reachable from the network. `res.locals.user` exists on a room handler
    // only because the session gate put it there.
    setAuthEnabled(true);
    expect((await request(app).get('/api/rooms')).status).toBe(401);
  });
});

/** The stored natural key of one author, read straight off the table. */
function readNaturalKey(db: Db, authorId: string): string | undefined {
  return (
    db.$client.prepare('SELECT natural_key AS k FROM authors WHERE id = ?').get(authorId) as
      { k: string } | undefined
  )?.k;
}

/** How many human author rows exist. One, always, on a single-user install. */
function countHumanAuthors(db: Db): number {
  return (
    db.$client.prepare("SELECT count(*) AS n FROM authors WHERE kind = 'human'").get() as {
      n: number;
    }
  ).n;
}
