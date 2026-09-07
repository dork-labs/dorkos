/**
 * `POST`/`DELETE /api/profile/identities/:authorId` — "this Telegram account is
 * me" (DOR-1778).
 *
 * The whole point of this file is the refusals. A link makes DorkOS treat one
 * external identity's messages as the operator's own words, which is to say it
 * SILENCES them — so the question that matters is not "does the happy path
 * write a column" but "can anybody other than the person who owns this install
 * cause a message to go unheard". The real {@link AuthorRegistry} runs
 * throughout, over a real database, because the structural half of the answer
 * (only a `platform:` row can be claimed) lives in the registry rather than in
 * the route.
 *
 * @module server/routes/__tests__/profile-identity-link
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { user, eq, type Db } from '@dorkos/db';
import {
  AuthorRegistry,
  isOwnerVoiceRecord,
  type AuthorRecord,
} from '../../services/rooms/author-registry.js';
import type { AvatarStore } from '../../services/identity/avatar-store.js';
import { createProfileRouter, type ProfileRouterDeps } from '../profile.js';

const OWNER_USER_ID = 'user-1';

/** The store is irrelevant to an identity link; the router takes one. */
const inertStore: AvatarStore = {
  put: async () => ({ url: '/api/profile/avatar/x' }),
  get: async () => null,
  delete: async () => {},
};

/** The operator's own Telegram account, as `postExternal` would mint it. */
const PHONE = {
  platformType: 'telegram',
  instanceId: 'tg-main',
  platformUserId: '900900',
  displayName: 'Dorian',
} as const;

describe('the operator claiming a platform identity', () => {
  const target = swappableServer();
  let db: Db;
  let registry: AuthorRegistry;
  let ownerAuthor: AuthorRecord;
  let phoneAuthor: AuthorRecord;

  /**
   * Mount the router. `hasAccount: false` is the DEFAULT install — login is
   * optional and off (ADR-0320) — where the `'local'` sentinel IS the owner.
   */
  function app(hasAccount = true, overrides: Partial<ProfileRouterDeps> = {}) {
    const server = express();
    server.use(express.json());
    server.use(
      '/api/profile',
      createProfileRouter({
        avatars: inertStore,
        caller: () => ownerAuthor,
        authors: registry,
        ownerAccount: () => (hasAccount ? { id: OWNER_USER_ID } : null),
        setAccountImage: () => {},
        setAccountName: () => {},
        setProfileDisplayName: () => {},
        ...overrides,
      })
    );
    return target.mount(server);
  }

  /** Whether the registry now reads that identity as the operator's own voice. */
  function claimed(authorId: string, hasAccount = true): boolean {
    const record = registry.getById(authorId);
    return record !== null && isOwnerVoiceRecord(record, hasAccount ? OWNER_USER_ID : null);
  }

  beforeEach(() => {
    db = createTestDb();
    db.insert(user).values({ id: OWNER_USER_ID, name: 'Dorian', email: 'dorian@dorkos.ai' }).run();
    registry = new AuthorRegistry(db);
    ownerAuthor = registry.bindOwner(OWNER_USER_ID);
    phoneAuthor = registry.resolveExternal(PHONE);
  });

  describe('what it does', () => {
    it('records the claim, so the identity now speaks with the operator’s voice', async () => {
      const res = await request(app()).post(`/api/profile/identities/${phoneAuthor.id}`);

      expect(res.status).toBe(204);
      expect(claimed(phoneAuthor.id)).toBe(true);
    });

    it('takes the claim back, and is happy to be asked twice', async () => {
      const server = app();
      await request(server).post(`/api/profile/identities/${phoneAuthor.id}`);

      const first = await request(server).delete(`/api/profile/identities/${phoneAuthor.id}`);
      const second = await request(server).delete(`/api/profile/identities/${phoneAuthor.id}`);

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      expect(claimed(phoneAuthor.id)).toBe(false);
    });

    it('works on an install with login off, where the owner is the local sentinel', async () => {
      // The default install (ADR-0320) has no `user` row at all. The claim names
      // the `'local'` key, which is what `bindOwner` later adopts.
      registry = new AuthorRegistry(createTestDb());
      ownerAuthor = registry.localHuman();
      phoneAuthor = registry.resolveExternal(PHONE);

      const res = await request(app(false)).post(`/api/profile/identities/${phoneAuthor.id}`);

      expect(res.status).toBe(204);
      expect(claimed(phoneAuthor.id, false)).toBe(true);
    });
  });

  describe('what it refuses — the spoof surface', () => {
    it('refuses an AGENT outright, before it reads an author id', async () => {
      // The vector this gate exists for: an agent that could write a link could
      // point one at any identity and silence every notification that identity's
      // messages would raise — somebody else's words going unheard, decided by a
      // machine. It is refused for being a machine, not for what it asked.
      const agent: AuthorRecord = { ...ownerAuthor, kind: 'agent' };

      const res = await request(app(true, { caller: () => agent })).post(
        `/api/profile/identities/${phoneAuthor.id}`
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
      expect(claimed(phoneAuthor.id)).toBe(false);
    });

    it('refuses an agent the unlink too, so a claim cannot be quietly dropped', async () => {
      const server = app();
      await request(server).post(`/api/profile/identities/${phoneAuthor.id}`);
      const agent: AuthorRecord = { ...ownerAuthor, kind: 'agent' };

      const res = await request(app(true, { caller: () => agent })).delete(
        `/api/profile/identities/${phoneAuthor.id}`
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
      expect(claimed(phoneAuthor.id)).toBe(true);
    });

    it('refuses a human author who is not the owner', async () => {
      // ADR 260727-184933 D6 says no second local account can exist; this is the
      // guard on that invariant, not a path anything walks. An invited person
      // claiming an identity would be silencing the OWNER's notifications.
      const stranger: AuthorRecord = { ...ownerAuthor, id: 'author-stranger' };

      const res = await request(app(true, { caller: () => stranger })).post(
        `/api/profile/identities/${phoneAuthor.id}`
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
      expect(claimed(phoneAuthor.id)).toBe(false);
    });

    it('refuses an AGENT’s author row even when the owner is the one asking', async () => {
      // The structural half, and the one that matters most: claiming an agent
      // would silence every DM that agent sends. The registry refuses any row
      // that is not somebody on a platform outside this machine, so the damaging
      // shape cannot be spelled at all — not by an agent, and not by the owner.
      const ana = registry.resolveAgent('/agents/ana', 'Ana');

      const res = await request(app()).post(`/api/profile/identities/${ana.id}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDENTITY_NOT_EXTERNAL');
      expect(claimed(ana.id)).toBe(false);
    });

    it('refuses the operator’s OWN local row, which is already them', async () => {
      const res = await request(app()).post(`/api/profile/identities/${ownerAuthor.id}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDENTITY_NOT_EXTERNAL');
    });

    it('answers 404 for an author id this install has never minted', async () => {
      const res = await request(app()).post('/api/profile/identities/author-nobody');

      expect(res.status).toBe(404);
    });
  });
});
