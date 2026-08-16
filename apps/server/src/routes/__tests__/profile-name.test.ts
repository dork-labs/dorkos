/**
 * `PATCH /api/profile` — what the operator wants to be called.
 *
 * The whole point of this file is the second describe block. The roster resolves
 * a person's name through a LADDER (`services/identity/operator-profile.ts`), so
 * "the write worked" is not a claim about a column — it is a claim about what
 * `GET /api/team` says afterwards, on BOTH kinds of install: one with an account
 * (where `user.name` is the only rung that can win) and one with login off
 * (where there is no `user` row at all and the stored profile is the only rung
 * a person can reach). A test that only asserted the column would pass against
 * an implementation that changes nothing a person can see.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { user, eq, type Db } from '@dorkos/db';
import { AuthorRegistry, type AuthorRecord } from '../../services/rooms/author-registry.js';
import type { AvatarStore } from '../../services/identity/avatar-store.js';
import { createProfileRouter, type ProfileRouterDeps } from '../profile.js';
import { createTeamRouter } from '../team.js';

const OWNER_USER_ID = 'user-1';

/** The store is irrelevant to a name write; it is here because the router takes one. */
const inertStore: AvatarStore = {
  put: async () => ({ url: '/api/profile/avatar/x' }),
  get: async () => null,
  delete: async () => {},
};

describe('PATCH /api/profile', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let ownerAuthor: AuthorRecord;
  /** Stands in for `config.profile.displayName`, which is real config on a real install. */
  let storedProfileName: string | null;

  /**
   * An install with an account. `hasAccount: false` is the DEFAULT install
   * (login is optional and off — ADR-0320): no `user` row exists, so the account
   * rung of the ladder is empty and nothing may be written to it.
   */
  function app(hasAccount = true, overrides: Partial<ProfileRouterDeps> = {}) {
    const account = () => (hasAccount ? { id: OWNER_USER_ID } : null);
    const server = express();
    server.use(express.json());
    server.use(
      '/api/profile',
      createProfileRouter({
        avatars: inertStore,
        caller: () => ownerAuthor,
        authors: registry,
        ownerAccount: account,
        setAccountImage: () => {},
        setAccountName: (userId, name) =>
          db.update(user).set({ name }).where(eq(user.id, userId)).run(),
        setProfileDisplayName: (displayName) => {
          storedProfileName = displayName;
        },
        ...overrides,
      })
    );
    server.use(
      '/api/team',
      createTeamRouter({
        authors: registry,
        // The roster is what these tests read back; the rooms reader is a
        // required dependency of the router and answers nothing here.
        rooms: { listRoomsForMember: () => [], listMembersForRooms: () => [] },
        activeClaims: () => [],
        listRooms: () => [],
        sessionActivity: () => Promise.resolve({}),
        ownerAccount: () =>
          hasAccount ? { id: OWNER_USER_ID, name: storedAccountName() ?? '' } : null,
        ownerEmail: () => (hasAccount ? 'dorian@dorkos.ai' : null),
        configDisplayName: () => storedProfileName,
        defaultAgentName: () => null,
      })
    );
    return server;
  }

  function storedAccountName(): string | null {
    return (
      db.select({ name: user.name }).from(user).where(eq(user.id, OWNER_USER_ID)).get()?.name ??
      null
    );
  }

  /** What the roster would show for the person reading it. */
  async function rosterSelfName(server: express.Express): Promise<string> {
    const res = await request(server).get('/api/team');
    expect(res.status).toBe(200);
    return res.body.members.find((m: { isSelf: boolean }) => m.isSelf).displayName;
  }

  beforeEach(() => {
    db = createTestDb();
    db.insert(user).values({ id: OWNER_USER_ID, name: 'Dorian', email: 'dorian@dorkos.ai' }).run();
    registry = new AuthorRegistry(db);
    ownerAuthor = registry.bindOwner(OWNER_USER_ID);
    storedProfileName = null;
  });

  /**
   * Re-stage as the DEFAULT install: login off, no account record, and the
   * operator is the unbound `'local'` author. Rebuilt from scratch rather than
   * mutated, because `bindOwner` is one-way — and this is the install shape
   * most people actually run, so it gets a real fixture rather than a flag.
   */
  function stageLoginOff(): express.Express {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    ownerAuthor = registry.localHuman();
    storedProfileName = null;
    return app(false);
  }

  describe('what a person sees afterwards', () => {
    it('changes the name on the roster when this install has an account', async () => {
      const server = app(true);
      expect(await rosterSelfName(server)).toBe('Dorian');

      const patched = await request(server).patch('/api/profile').send({ displayName: 'Dorian C' });
      expect(patched.status).toBe(200);
      expect(patched.body).toEqual({ displayName: 'Dorian C' });

      expect(await rosterSelfName(server)).toBe('Dorian C');
    });

    it('changes the name on the roster with login off, where there is no account to write', async () => {
      const server = stageLoginOff();
      // The default install's honest starting point: nothing knows this
      // person's name, so the roster falls all the way through to the literal.
      expect(await rosterSelfName(server)).toBe('You');

      const patched = await request(server).patch('/api/profile').send({ displayName: 'Dorian' });
      expect(patched.status).toBe(200);

      expect(await rosterSelfName(server)).toBe('Dorian');
      // Nothing was written to any account record, because there is none.
      expect(storedAccountName()).toBeNull();
    });

    it('writes both rungs at once, so the two cannot disagree', async () => {
      await request(app(true)).patch('/api/profile').send({ displayName: 'Dorian C' });
      expect(storedAccountName()).toBe('Dorian C');
      expect(storedProfileName).toBe('Dorian C');
    });

    it('leaves the author record saying "You", so a room still reads as your own seat', async () => {
      const server = app(true);
      await request(server).patch('/api/profile').send({ displayName: 'Dorian C' });

      // The deliberate divergence (spec §W2.2): a roster has no "you" framing
      // and renders the real name; a room does, and keeps the literal. Writing
      // the author record would relabel every message already posted.
      expect(registry.getById(ownerAuthor.id)?.displayName).toBe('You');
    });
  });

  describe('what it refuses', () => {
    it('refuses an agent — a person’s name is theirs to set', async () => {
      const agent: AuthorRecord = { ...ownerAuthor, kind: 'agent' };
      const res = await request(app(true, { caller: () => agent }))
        .patch('/api/profile')
        .send({ displayName: 'Definitely The Operator' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
      // Refused before either write, not after one of them.
      expect(storedAccountName()).toBe('Dorian');
      expect(storedProfileName).toBeNull();
    });

    it('refuses a human author who is not the owner, and writes NOTHING', async () => {
      // `config.profile.displayName` is install-global rather than per-author,
      // so a second person saving their own name would rewrite the OWNER's
      // roster row. ADR 260727-184933 D6 says no such person can exist locally;
      // this is the guard on that invariant, not a path anything walks.
      const stranger: AuthorRecord = { ...ownerAuthor, id: 'author-stranger' };
      const res = await request(app(true, { caller: () => stranger }))
        .patch('/api/profile')
        .send({ displayName: 'Not The Owner' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
      expect(storedAccountName()).toBe('Dorian');
      // The half that would otherwise have leaked: the config write is not
      // behind the account check unless it is put there deliberately.
      expect(storedProfileName).toBeNull();
    });

    it('refuses an empty name rather than blanking the roster row', async () => {
      const res = await request(app(true)).patch('/api/profile').send({ displayName: '   ' });
      expect(res.status).toBe(400);
      expect(storedAccountName()).toBe('Dorian');
    });

    it('refuses a name longer than the column allows', async () => {
      const res = await request(app(true))
        .patch('/api/profile')
        .send({ displayName: 'x'.repeat(81) });
      expect(res.status).toBe(400);
      expect(storedAccountName()).toBe('Dorian');
    });
  });
});
