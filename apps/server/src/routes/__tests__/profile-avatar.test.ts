/**
 * `POST/GET/DELETE /api/profile/avatar` over HTTP.
 *
 * Three things are being pinned here, and only one of them is "the photo
 * round-trips". The second is that a hostile upload is refused by what the bytes
 * ARE rather than by what the request claimed — a `.png` full of GIF, an SVG
 * that is really a script, a file over the cap. The third is the seam: the last
 * describe block swaps in a store that answers with an absolute CDN URL and
 * asserts the roster serves exactly that, with no route, schema or client change.
 * That block is what makes "sync-ready" a fact rather than a claim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { user, eq, type Db } from '@dorkos/db';
import { AuthorRegistry, type AuthorRecord } from '../../services/rooms/author-registry.js';
import { RoomError } from '../../services/rooms/room-errors.js';
import { LocalAvatarStore } from '../../services/identity/local-avatar-store.js';
import type { AvatarStore } from '../../services/identity/avatar-store.js';
import { createProfileRouter, type ProfileRouterDeps } from '../profile.js';
import { createTeamRouter } from '../team.js';

const OWNER_USER_ID = 'user-1';

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 3)]);
const THREE_MB = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 0)]);
/**
 * "RIFF"/"WEBP" with bit 7 set on every letter, wrapped around an HTML payload.
 * `toString('ascii')` masks bit 7, so a text-based sniff reads these as the
 * literal magic — review uploaded exactly this and had it stored and served back
 * as `image/webp`.
 */
const HIGH_BIT_RIFF = Buffer.concat([
  Buffer.from([0xd2, 0xc9, 0xc6, 0xc6]),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from([0xd7, 0xc5, 0xc2, 0xd0]),
  Buffer.from('<html><script>alert(1)</script></html>'),
]);

describe('/api/profile/avatar', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let dorkHome: string;
  let store: LocalAvatarStore;
  let ownerAuthor: AuthorRecord;

  function app(overrides: Partial<ProfileRouterDeps> = {}) {
    const server = express();
    server.use(
      '/api/profile',
      createProfileRouter({
        avatars: store,
        caller: () => ownerAuthor,
        authors: registry,
        ownerAccount: () => ({ id: OWNER_USER_ID }),
        setAccountImage: (userId, imageUrl) =>
          db.update(user).set({ image: imageUrl }).where(eq(user.id, userId)).run(),
        // The name half of the router, which this file does not exercise —
        // `profile-name.test.ts` owns it.
        setAccountName: (userId, name) =>
          db.update(user).set({ name }).where(eq(user.id, userId)).run(),
        setProfileDisplayName: () => {},
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
        ownerAccount: () => ({ id: OWNER_USER_ID, name: 'Dorian' }),
        ownerEmail: () => 'dorian@dorkos.ai',
        configDisplayName: () => null,
        defaultAgentName: () => null,
      })
    );
    return server;
  }

  function storedAccountImage(): string | null | undefined {
    return db.select({ image: user.image }).from(user).where(eq(user.id, OWNER_USER_ID)).get()
      ?.image;
  }

  beforeEach(async () => {
    db = createTestDb();
    db.insert(user).values({ id: OWNER_USER_ID, name: 'Dorian', email: 'dorian@dorkos.ai' }).run();
    registry = new AuthorRegistry(db);
    ownerAuthor = registry.bindOwner(OWNER_USER_ID);
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-profile-'));
    store = new LocalAvatarStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  describe('the round trip', () => {
    it('stores the photo, serves it back, and tells both identity records about it', async () => {
      const posted = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png', contentType: 'image/png' });

      expect(posted.status).toBe(200);
      expect(posted.body.imageUrl).toMatch(/^\/api\/profile\/avatar\//);
      expect(await readdir(path.join(dorkHome, 'avatars'))).toEqual([`${ownerAuthor.id}.png`]);

      // Both identity records hold the SAME url — the account and the roster
      // cannot disagree about what this person looks like.
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBe(posted.body.imageUrl);
      expect(storedAccountImage()).toBe(posted.body.imageUrl);

      const fetched = await request(app()).get(posted.body.imageUrl);
      expect(fetched.status).toBe(200);
      expect(fetched.headers['content-type']).toBe('image/png');
      expect(fetched.headers['x-content-type-options']).toBe('nosniff');
      expect(fetched.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(fetched.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(fetched.headers.etag).toMatch(/^"[0-9a-f]+"$/);
      expect(Buffer.from(fetched.body)).toEqual(PNG);
    });

    it('clears the file and both records on delete', async () => {
      const posted = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      const deleted = await request(app()).delete('/api/profile/avatar');
      expect(deleted.status).toBe(204);

      expect(await readdir(path.join(dorkHome, 'avatars'))).toEqual([]);
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBeNull();
      expect(storedAccountImage()).toBeNull();
      expect((await request(app()).get(posted.body.imageUrl)).status).toBe(404);
    });

    it('answers 304 when the browser already has that exact photo', async () => {
      const posted = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });
      const first = await request(app()).get(posted.body.imageUrl);

      const again = await request(app())
        .get(posted.body.imageUrl)
        .set('If-None-Match', first.headers.etag);

      expect(again.status).toBe(304);
    });

    it('answers 404 for an identity with no photo', async () => {
      expect((await request(app()).get('/api/profile/avatar/nobody')).status).toBe(404);
    });

    it('serves must-revalidate when the request names no version at all', async () => {
      const posted = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });
      const bare = posted.body.imageUrl.split('?')[0];

      const fetched = await request(app()).get(bare);

      expect(fetched.status).toBe(200);
      expect(fetched.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    });

    it('serves must-revalidate when ?v= names a version that is no longer current', async () => {
      // The path a `put()` always writes is the same one, so a `?v=` sitting in
      // a stale cache — one photo replaced by another — no longer names what
      // the path serves today. Caching that as `immutable` would be a promise
      // this route cannot keep.
      const posted = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });
      const stalePath = posted.body.imageUrl.split('?')[0];

      const fetched = await request(app()).get(`${stalePath}?v=0000000000000000`);

      expect(fetched.status).toBe(200);
      expect(fetched.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    });

    it('serves immutable only when ?v= names the photo currently behind the path', async () => {
      const posted = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      const fetched = await request(app()).get(posted.body.imageUrl);

      expect(posted.body.imageUrl).toContain('?v=');
      expect(fetched.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    });
  });

  describe('what it refuses', () => {
    it('refuses a file over 2 MB before writing a byte of it', async () => {
      const res = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', THREE_MB, { filename: 'huge.png', contentType: 'image/png' });

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('AVATAR_TOO_LARGE');
      await expect(readdir(path.join(dorkHome, 'avatars'))).rejects.toThrow();
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBeNull();
    });

    it.each([
      ['accepts', 'exactly 2 MB', 0, 200],
      ['refuses', 'one byte over 2 MB', 1, 413],
    ])('%s a photo of %s', async (_verb, _what, over, expected) => {
      const size = 2 * 1024 * 1024 + over;
      const image = Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 0)]);
      expect(image.length).toBe(size);

      const res = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', image, { filename: 'big.png', contentType: 'image/png' });

      expect(res.status).toBe(expected);
    });

    it('refuses an SVG, however it is labelled', async () => {
      const res = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', SVG, { filename: 'me.png', contentType: 'image/png' });

      expect(res.status).toBe(415);
      expect(res.body.code).toBe('AVATAR_TYPE_UNSUPPORTED');
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBeNull();
    });

    it('believes the bytes, not the name: a .png whose content is a GIF is refused', async () => {
      const res = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', GIF, { filename: 'me.png', contentType: 'image/png' });

      expect(res.status).toBe(415);
      expect(res.body.code).toBe('AVATAR_TYPE_UNSUPPORTED');
    });

    it('refuses HTML wearing high-bit RIFF/WEBP magic, and stores nothing', async () => {
      const res = await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', HIGH_BIT_RIFF, { filename: 'me.webp', contentType: 'image/webp' });

      expect(res.status).toBe(415);
      expect(res.body.code).toBe('AVATAR_TYPE_UNSUPPORTED');
      await expect(readdir(path.join(dorkHome, 'avatars'))).rejects.toThrow();
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBeNull();
    });

    it('refuses a POST carrying no file at all', async () => {
      const res = await request(app()).post('/api/profile/avatar');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AVATAR_MISSING');
    });

    it('never writes the owner’s account record for somebody who is not the owner', async () => {
      // ADR 260727-184933 D6 keeps this install single-account, so this caller
      // cannot occur today. `room-caller.ts` still checks rather than assumes,
      // for the reason that applies here too: if the invariant ever broke,
      // assuming would let a second person overwrite the OWNER's account photo.
      const stranger = registry.human('user-999');

      const res = await request(app({ caller: () => stranger }))
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      expect(res.status).toBe(200);
      // Their own roster row updates...
      expect(registry.getById(stranger.id)?.imageUrl).toBe(res.body.imageUrl);
      // ...and the owner's account and roster row are untouched.
      expect(storedAccountImage()).toBeNull();
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBeNull();
    });

    it('never clears the owner’s account record on a stranger’s delete', async () => {
      await request(app())
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });
      const ownerImage = storedAccountImage();
      expect(ownerImage).not.toBeNull();

      const stranger = registry.human('user-999');
      const res = await request(app({ caller: () => stranger })).delete('/api/profile/avatar');

      expect(res.status).toBe(204);
      expect(storedAccountImage()).toBe(ownerImage);
    });

    it('refuses an agent — a profile photo is the operator’s to set', async () => {
      const agent = registry.resolveAgent('/tmp/agent-ana', 'Ana');
      const res = await request(app({ caller: () => agent }))
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
    });

    it('answers 401 when the caller seam refuses the request outright', async () => {
      // `resolveCaller` THROWS for an agent token this machine cannot verify
      // (DOR-1361), and this router's `caller` seam is that function in
      // production. All three profile writes advertise the 401; this is what
      // pins the router actually producing one rather than a 500, and it is the
      // seam rather than the header because the header never reaches here — the
      // dependency is injected precisely so this file mints no author rows.
      const refusing = () => {
        throw new RoomError(
          'AGENT_IDENTITY_UNVERIFIED',
          'That agent identity could not be verified.'
        );
      };

      const res = await request(app({ caller: refusing }))
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
      // And the bytes were never stored: the seam refuses before multer runs.
      expect(res.body).not.toHaveProperty('imageUrl');
    });

    it.each(['..%2Fsecret', '..', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'])(
      'cannot be walked out of the avatar directory with %s',
      async (id) => {
        const res = await request(app()).get(`/api/profile/avatar/${id}`);
        expect(res.status).toBe(404);
      }
    );
  });

  describe('the seam', () => {
    /**
     * A store that keeps nothing locally and answers with an absolute URL —
     * exactly what a cloud-backed implementation would do.
     */
    const cdn: AvatarStore = {
      put: async () => ({ url: 'https://cdn.example/x.png' }),
      get: async () => null,
      delete: async () => {},
    };

    it('serves whatever URL the store returned, absolute host and all', async () => {
      const posted = await request(app({ avatars: cdn }))
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      expect(posted.body.imageUrl).toBe('https://cdn.example/x.png');
      expect(registry.getById(ownerAuthor.id)?.imageUrl).toBe('https://cdn.example/x.png');
      expect(storedAccountImage()).toBe('https://cdn.example/x.png');
      // Nothing was written to this machine: the route never touched a path.
      await expect(readdir(path.join(dorkHome, 'avatars'))).rejects.toThrow();
    });

    it('carries that absolute URL to the roster with no route or schema change', async () => {
      const server = app({ avatars: cdn });
      await request(server)
        .post('/api/profile/avatar')
        .attach('avatar', PNG, { filename: 'me.png' });

      const roster = await request(server).get('/api/team');
      const self = roster.body.members.find((m: { isSelf: boolean }) => m.isSelf);

      expect(self.imageUrl).toBe('https://cdn.example/x.png');
    });
  });
});
