/**
 * The universal half of the `CommunityAdapter` conformance suite: the
 * assertions every backend owes, with no branch and no opt-out.
 *
 * These are the properties that stay true whatever a backend declares — an
 * address that carries its own community, a snapshot before any entry, a resume
 * that is gap-free or refuses, exhaustion declared rather than inferred, stable
 * entry ids, honest attribution, a terminal event when a room goes away, one
 * defined answer for a room the caller cannot have, no credential anywhere on
 * the wire, and — U17, added after an adapter shipped minting a cursor its own
 * reader refused — every cursor an adapter hands out being one it takes back.
 *
 * **U18–U22 exist because this suite was adapter-vs-itself in places** (DOR-792
 * review). Every one of them is an obligation the port's own TSDoc already
 * states and nothing checked: that emission order is ONE order and every
 * surface agrees on it, that the mentions a writer resolved survive the write
 * ("`responseMode: 'mention-only'` is unusable without it"), that a receipt's
 * cursor resumes AFTER the entry it names ("so a poster can subscribe without a
 * round-trip"), that a declaration a consumer is handed cannot rewrite the next
 * one, and that a foreign cursor is refused on the PAGING surface as well as the
 * streaming one. Two real lossy mutations passed all ninety-eight assertions
 * that came before them; these are the ones that had to be added rather than
 * assumed.
 *
 * @module test-utils/community-conformance-universal
 */
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_GATED_CAPABILITIES,
  CommunityCapabilitiesSchema,
  CommunityConnectionSchema,
  CommunityEntrySchema,
  CommunityMemberSchema,
  CommunityRefSchema,
  CommunityRoomNotFoundError,
  CommunityRoomSchema,
  CommunityUnsupportedError,
  StaleCommunityCursorError,
  type CommunityAdapter,
  type CommunityCursor,
} from '@dorkos/shared/community-adapter';
import {
  GATED_PROBES,
  PAGE_SIZE,
  WIDE_PAGE,
  assertImported,
  nextEvent,
  pageAllEntries,
  type CommunityConformanceContext,
} from './community-conformance-support.js';

/**
 * Register the assertions every adapter owes.
 *
 * @param ctx - The suite's resolved hooks and helpers.
 */
export function registerUniversalAssertions(ctx: CommunityConformanceContext): void {
  const { makeAdapter, arrange, awaitRoomEvent, storeSnapshot, eventTimeoutMs, opts } = ctx;
  const { seedRoom, plantedCredential, makeUnreachableAdapter, makeEvictedRoom, secondCommunity } =
    opts;
  // Read once at REGISTRATION time so a case this backend cannot run registers a
  // named skip instead of returning green from inside the test body. A silent
  // return is the thing the module doc promises not to do.
  const declared = makeAdapter().getCapabilities();

  describe('universal', () => {
    it('U1 declares capabilities that parse, match the instance, and are internally consistent', () => {
      const adapter = makeAdapter();
      const caps = adapter.getCapabilities();
      const parsed = CommunityCapabilitiesSchema.safeParse(caps);
      expect(
        parsed.success,
        `malformed capabilities: ${parsed.success ? '' : parsed.error.message}`
      ).toBe(true);
      expect(caps.type, 'capabilities.type must equal adapter.type').toBe(adapter.type);

      if (caps.roomList === 'poll') {
        expect(
          caps.roomListPollIntervalMs,
          "a 'poll' adapter must declare the interval it polls at"
        ).toBeGreaterThan(0);
      }

      if (caps.roles.supported) {
        expect(
          caps.roles.values.length,
          'a roles-supporting backend declares its roles'
        ).toBeGreaterThan(0);
        if (caps.roles.default !== undefined) {
          expect(
            caps.roles.values.map((r) => r.id),
            'roles.default must reference a declared role'
          ).toContain(caps.roles.default);
        }
        expect(
          caps.roles.values.filter((r) => r.isOwner === true).length,
          'at most one role may be the owner'
        ).toBeLessThanOrEqual(1);
      } else {
        expect(caps.roles.values, 'a backend with no roles declares none').toEqual([]);
      }
    });

    it('U2 reports connection failure as a typed status and never throws', async () => {
      const adapter = makeAdapter();
      const connection = await adapter.connect();
      const parsed = CommunityConnectionSchema.safeParse(connection);
      expect(
        parsed.success,
        `malformed connection: ${parsed.success ? '' : parsed.error.message}`
      ).toBe(true);
      if (connection.status === 'connected') {
        expect(connection.identity, "a 'connected' result carries the identity").toBeDefined();
      } else {
        expect(connection.error, 'a non-connected result carries diagnostic detail').toBeTruthy();
      }

      // The branch that catches an adapter which throws instead of typing its
      // failure: an unreachable host is a normal outcome, not an exception.
      const unreachable = makeUnreachableAdapter();
      const failed = await unreachable.connect();
      expect(failed.status, 'an unreachable host is a typed status').toBe('unreachable');
      expect(failed.identity, 'a failed connection carries no identity').toBeUndefined();
      expect(failed.error, 'a failed connection carries diagnostic detail').toBeTruthy();
    });

    it('U3 carries its own community on every address it emits', async () => {
      const { adapter } = await arrange();
      const ref = CommunityRefSchema.safeParse(adapter.community);
      expect(
        ref.success,
        `adapter.community must be path-safe (it becomes a directory name): ${ref.success ? '' : ref.error.message}`
      ).toBe(true);

      const rooms = await adapter.listRooms();
      expect(rooms.length, 'the seeded room must be listed').toBeGreaterThan(0);
      for (const room of rooms) {
        const parsed = CommunityRoomSchema.safeParse(room);
        expect(
          parsed.success,
          `malformed room: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
        expect(room.community, 'every address must carry this adapter’s community').toBe(
          adapter.community
        );
        const roundTripped = await adapter.getRoom(room.roomId);
        expect(roundTripped?.roomId, 'getRoom must round-trip every listed id').toBe(room.roomId);
      }

      await expect(
        adapter.getRoom('no-such-room-id'),
        'an unknown room resolves null, never throws'
      ).resolves.toBeNull();
    });

    it('U4 never returns a thread as a room', async () => {
      const { adapter, caps, roomId } = await arrange();
      const before = (await adapter.listRooms()).map((r) => r.roomId).sort();

      if (caps.canPost) {
        const history = await pageAllEntries(adapter, roomId);
        const root = history.entries[0]!;
        await adapter.post(roomId, { text: 'a threaded reply', parentEntryId: root.id });
        const after = (await adapter.listRooms()).map((r) => r.roomId).sort();
        expect(after, 'a thread is a relation between entries, never a new room').toEqual(before);
      }

      // A room whose kind is a thread cannot even parse: the room-kind
      // vocabulary has no such member since threads moved onto the entry.
      for (const room of await adapter.listRooms()) {
        expect(CommunityRoomSchema.safeParse(room).success).toBe(true);
      }
    });

    it('U5 opens a subscription with a snapshot carrying a cursor, before any entry', async () => {
      const { adapter, roomId } = await arrange();
      const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
      try {
        const first = await nextEvent(iterator, 'the opening snapshot', eventTimeoutMs);
        expect(first.type, 'a subscription opens with a snapshot').toBe('snapshot');
        if (first.type === 'snapshot') {
          expect(first.cursor, 'the snapshot carries the cursor a resume starts from').toBeTruthy();
          expect(first.room.roomId).toBe(roomId);
        }
      } finally {
        await iterator.return?.();
      }
    });

    it('U6 resumes gap-free or throws eagerly — there is no third outcome', async () => {
      assertImported(StaleCommunityCursorError, 'StaleCommunityCursorError');
      const { adapter, roomId } = await arrange();
      const { entries } = await pageAllEntries(adapter, roomId);
      expect(
        entries.length,
        'seedRoom must arrange a room with at least two entries'
      ).toBeGreaterThanOrEqual(2);

      const from = entries[0]!;
      const expectedIds = entries.slice(1).map((e) => e.id);

      let stream;
      try {
        // Constructed, awaiting nothing: the throw must land here or not at all.
        stream = adapter.subscribeRoom(roomId, from.cursor);
      } catch (err) {
        expect(err, 'a refused resume throws StaleCommunityCursorError, eagerly').toBeInstanceOf(
          StaleCommunityCursorError
        );
        return;
      }

      const iterator = stream[Symbol.asyncIterator]();
      const seen = new Set<string>();
      try {
        const deadline = Date.now() + eventTimeoutMs;
        while (!expectedIds.every((id) => seen.has(id)) && Date.now() < deadline) {
          const event = await nextEvent(
            iterator,
            'the resumed entries',
            Math.max(1, deadline - Date.now())
          );
          if (event.type === 'snapshot') for (const e of event.entries) seen.add(e.id);
          if (event.type === 'entry') seen.add(event.entry.id);
        }
      } finally {
        await iterator.return?.();
      }
      const missing = expectedIds.filter((id) => !seen.has(id));
      expect(missing, 'a resume that skips an entry is a gap, and there is no best-effort').toEqual(
        []
      );
    });

    it('U7 rejects a cursor minted for another room, never serves it silently', async () => {
      assertImported(StaleCommunityCursorError, 'StaleCommunityCursorError');
      const { adapter } = await arrange();
      const roomA = await seedRoom(adapter);
      const roomB = await seedRoom(adapter);
      const { entries } = await pageAllEntries(adapter, roomA);
      const foreign = entries[0]!.cursor;

      expect(
        () => adapter.subscribeRoom(roomB, foreign),
        'a cursor from another room must be rejected, not bounded'
      ).toThrow(StaleCommunityCursorError);
    });

    if (secondCommunity) {
      it('U7 rejects a cursor minted by another community', async () => {
        assertImported(StaleCommunityCursorError, 'StaleCommunityCursorError');
        const { adapter } = await arrange();
        const roomId = await seedRoom(adapter);

        const other = secondCommunity();
        await other.connect();
        const otherRoomId = await seedRoom(other);
        const otherEntries = await pageAllEntries(other, otherRoomId);

        expect(
          () => adapter.subscribeRoom(roomId, otherEntries.entries[0]!.cursor),
          'a cursor from another community must be rejected'
        ).toThrow(StaleCommunityCursorError);
      });
    } else {
      it.skip('U7 cross-community cursor rejection (no secondCommunity hook supplied)', () => {});
    }

    it('U8 declares exhaustion only via a null cursor, and pages over every entry once', async () => {
      const { adapter, roomId } = await arrange();
      const full = await adapter.listEntries(roomId, { limit: 500 });
      const paged = await pageAllEntries(adapter, roomId, PAGE_SIZE);

      expect(
        paged.pages,
        'a page-size-of-one walk over two or more entries must take more than one page'
      ).toBeGreaterThan(1);
      expect(
        paged.entries.map((e) => e.id),
        'paging to a null cursor visits every entry exactly once'
      ).toEqual(full.entries.map((e) => e.id));

      const firstPage = await adapter.listEntries(roomId, { limit: PAGE_SIZE });
      expect(
        firstPage.nextCursor,
        'a full page with more available must carry a non-null cursor'
      ).not.toBeNull();

      expect(
        paged.emptyAfterPromise,
        'a non-null cursor promises there is more; following it into an empty page is exhaustion inferred from row counts, one page late'
      ).toBe(false);
    });

    it('U9 keeps entry ids stable and unique, so an overlapping replay dedupes', async () => {
      const { adapter, roomId } = await arrange();
      const { entries } = await pageAllEntries(adapter, roomId);
      const topLevelIds = entries.map((e) => e.id);
      expect(new Set(topLevelIds).size, 'entry ids must be unique within a room').toBe(
        topLevelIds.length
      );

      const again = await pageAllEntries(adapter, roomId);
      expect(
        again.entries.map((e) => e.id),
        'entry ids must be stable across reads'
      ).toEqual(topLevelIds);

      // Every id this room holds, THREAD REPLIES INCLUDED. A room's stream
      // legitimately replays replies, while the default read returns top-level
      // entries only — so a known-id set built from the default read alone
      // false-reds on a correct backend the moment its fixture seeds one reply.
      const knownIds = new Set(topLevelIds);
      for (const entry of entries) {
        for (const reply of (await adapter.listEntries(roomId, { thread: entry.id, limit: 500 }))
          .entries) {
          knownIds.add(reply.id);
        }
      }

      // A replay window overlapping the snapshot window must dedupe by id.
      const iterator = adapter.subscribeRoom(roomId, entries[0]!.cursor)[Symbol.asyncIterator]();
      try {
        const snapshot = await nextEvent(iterator, 'the resumed snapshot', eventTimeoutMs);
        const replayed = snapshot.type === 'snapshot' ? snapshot.entries.map((e) => e.id) : [];
        expect(new Set(replayed).size, 'a replay must not repeat an id').toBe(replayed.length);
        for (const id of replayed) {
          expect(
            [...knownIds],
            'a replayed id must be one this room actually holds, thread replies included'
          ).toContain(id);
        }
      } finally {
        await iterator.return?.();
      }
    });

    it('U10 gives every entry a well-formed author', async () => {
      const { adapter, roomId } = await arrange();
      const { entries } = await pageAllEntries(adapter, roomId);

      for (const entry of entries) {
        const parsed = CommunityEntrySchema.safeParse(entry);
        expect(
          parsed.success,
          `malformed entry: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
      }

      // Deliberately NOT asserted: that every `authorId` is in the room's
      // CURRENT roster. An entry outlives its author's membership — our own
      // rooms model says so outright (`room-context.ts`: a departed member's
      // entries stay in the log) — so a roster-membership requirement would
      // fail a correct backend. Attribution is proven below instead, where the
      // fixture can arrange the case the invariant is actually about.
    });

    if (declared.agentAdmission === 'none') {
      it.skip("U10 an agent's entry never carries its owner's id (this backend cannot admit agents)", () => {});
    } else if (opts.seedAgentEntry) {
      it("U10 never attributes an agent's entry to its owner", async () => {
        const { adapter, caps, roomId, identityMemberId } = await arrange();

        const agent = await adapter.admitAgent({ agentId: 'u10-agent', displayName: 'Agent' });
        expect(agent.ownerMemberId, 'the agent is vouched by the connected identity').toBe(
          identityMemberId
        );
        if (caps.roomAdmin) await adapter.addMember(roomId, agent.memberId);

        const entryId = await opts.seedAgentEntry!(adapter, roomId, agent);
        const written = [
          ...(await pageAllEntries(adapter, roomId)).entries,
          ...(await adapter.listEntries(roomId, { limit: 500 })).entries,
        ].find((e) => e.id === entryId);

        expect(written, `the arranged agent entry '${entryId}' must be readable`).toBeDefined();
        expect(
          written!.authorId,
          "an entry an agent wrote is the agent's, not its owner's — the cheapest invariant to lose"
        ).toBe(agent.memberId);
      });
    } else {
      it.skip("U10 an agent's entry never carries its owner's id (no seedAgentEntry hook supplied)", () => {});
    }

    // DELIBERATE DEVIATION FROM THE FROZEN SPEC, recorded rather than hidden.
    // `02-specification.md` §9 lists U11 as UNIVERSAL — "A room made unservable
    // mid-subscription yields a terminal `room_closed` with a valid reason —
    // never a throw, never a silent end. (Cause-specific reason checked only
    // under `makeEvictedRoom`.)" — and gates only the REASON on the hook, not
    // the assertion. It is not implementable that way: making a room unservable
    // requires an out-of-band act the port deliberately does not expose, and the
    // one gated method that comes close (archiving, via `roomAdmin`) is a
    // different thing — an archived room still reads. So the whole case is
    // hook-gated, and an adapter that omits the hook declines it by name below.
    if (makeEvictedRoom) {
      it('U11 ends an unservable room with a terminal room_closed, never a throw or a silent end', async () => {
        const { adapter, roomId } = await arrange();
        const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
        try {
          await nextEvent(iterator, 'the opening snapshot', eventTimeoutMs);
          const arrangedReason = await makeEvictedRoom(adapter, roomId);
          const closed = await awaitRoomEvent(
            iterator,
            (e) => e.type === 'room_closed',
            'the terminal room_closed event'
          );
          expect(closed.type).toBe('room_closed');
          if (closed.type === 'room_closed') {
            expect(
              closed.reason,
              'the reason must be the cause the fixture arranged, never the friendlier guess'
            ).toBe(arrangedReason);
          }
          const after = await iterator.next();
          expect(after.done, 'room_closed is terminal').toBe(true);
        } finally {
          await iterator.return?.();
        }
      });
    } else {
      it.skip('U11 terminal room_closed (no makeEvictedRoom hook supplied)', () => {});
    }

    it('U12 leaks its credential into nothing the port returns', async () => {
      const { adapter, caps, roomId, identityMemberId } = await arrange();
      const surfaces: unknown[] = [
        caps,
        await adapter.connect(),
        await adapter.listRooms(),
        await adapter.getRoom(roomId),
        await adapter.listEntries(roomId, { limit: 500 }),
        await adapter.listMembers(roomId),
      ];
      if (caps.invite !== 'none') {
        surfaces.push(await adapter.createInvite(caps.invite === 'room' ? { roomId } : {}));
      }
      if (caps.readCursor !== 'none') surfaces.push(await adapter.getReadCursor(roomId));
      if (caps.agentAdmission === 'owner-vouched') {
        surfaces.push(
          await adapter.admitAgent({ agentId: 'leak-probe', displayName: 'Leak Probe' })
        );
      }
      expect(identityMemberId, 'the connected identity must be knowable').not.toBe('');

      const serialized = JSON.stringify(surfaces);
      expect(
        serialized.includes(plantedCredential),
        'no credential may cross this port — not on a DTO, not in features'
      ).toBe(false);
    });

    it('U13 refuses every method whose capability is off — and refuses nothing else', async () => {
      const { adapter, caps, roomId, identityMemberId } = await arrange();
      const ctx = { roomId, memberId: identityMemberId };

      // Pass 1 — the off flags refuse, and refuse cleanly. Re-snapshotting per
      // probe is what makes "never a partial write" checkable rather than a
      // claim: a refusal that wrote half of something shows up as a diff.
      for (const capability of COMMUNITY_GATED_CAPABILITIES) {
        const probe = GATED_PROBES[capability];
        if (!probe.isOff(caps)) continue;
        for (const { method, run } of probe.calls(adapter, ctx)) {
          const before = await storeSnapshot(adapter, roomId);
          await expect(
            run(),
            `'${method}' must reject with CommunityUnsupportedError when '${capability}' is off — never a silent no-op`
          ).rejects.toBeInstanceOf(CommunityUnsupportedError);
          const after = await storeSnapshot(adapter, roomId);
          expect(after, `'${method}' refused but changed the store — a partial write`).toEqual(
            before
          );
        }
      }

      // Pass 2 — the ON flags do NOT refuse. Without this the assertion above
      // is satisfied by an adapter that refuses everything, which is the way a
      // capability gate fails silently in the other direction. A supported
      // method may still fail for its own reasons (an unknown member), but it
      // may never claim its capability is off.
      for (const capability of COMMUNITY_GATED_CAPABILITIES) {
        const probe = GATED_PROBES[capability];
        if (probe.isOff(caps)) continue;
        for (const { method, run } of probe.calls(adapter, ctx)) {
          try {
            await run();
          } catch (err) {
            expect(
              err,
              `'${method}' claimed '${capability}' is unsupported, but the adapter declares it on`
            ).not.toBeInstanceOf(CommunityUnsupportedError);
          }
        }
      }
    });

    it('U14 disconnects idempotently, including from a never-connected adapter', async () => {
      const fresh = makeAdapter();
      await expect(fresh.disconnect()).resolves.toBeUndefined();

      const adapter = makeAdapter();
      await adapter.connect();
      await expect(adapter.disconnect()).resolves.toBeUndefined();
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });

    it('U15 enumerates a well-formed roster and answers an unknown room with an empty one', async () => {
      const { adapter, roomId, identityMemberId } = await arrange();
      const members = await adapter.listMembers(roomId);
      for (const member of members) {
        const parsed = CommunityMemberSchema.safeParse(member);
        expect(
          parsed.success,
          `malformed member: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
        expect(member.community, 'every member carries this adapter’s community').toBe(
          adapter.community
        );
      }
      expect(
        members.map((m) => m.memberId),
        'the connected identity is a member of a room it can read'
      ).toContain(identityMemberId);

      await expect(
        adapter.listMembers('no-such-room-id'),
        'an unknown room has an empty roster, never a throw'
      ).resolves.toEqual([]);
    });

    it('U16 refuses to stream a room it cannot serve, eagerly', async () => {
      assertImported(CommunityRoomNotFoundError, 'CommunityRoomNotFoundError');
      const { adapter } = await arrange();

      // Constructed, awaiting nothing — the U6/U7 shape, for the same reason.
      // The two failures this catches are the two an adapter actually ships: a
      // stream that opens and never yields (a caller parks on it forever,
      // unable to tell it from a quiet room), and a refusal deferred to the
      // first pull (a caller holding a plain `try` never sees it).
      //
      // DELIBERATELY NOT ASSERTED: that a room which exists but is invisible
      // throws the SAME refusal. Arranging one needs a second identity the port
      // does not expose, so the collapse is stated on
      // `CommunityRoomNotFoundError` and held by each adapter's own tests —
      // this case proves the shape, not the discretion.
      expect(
        () => adapter.subscribeRoom('no-such-room-id'),
        'a room this identity cannot stream is refused with CommunityRoomNotFoundError, at call time'
      ).toThrow(CommunityRoomNotFoundError);
    });

    it('U17 accepts every cursor it minted, on both the surfaces that take one', async () => {
      // The port says a cursor must be REJECTED when it belongs somewhere else.
      // Nothing said the converse out loud, so nothing checked it: an adapter
      // whose encoding cannot round-trip one of its own tokens fails the caller
      // in the way that looks most like a backend problem — a resume that throws
      // `StaleCommunityCursorError` for a cursor that is not stale at all, on a
      // room that is perfectly healthy. The caller then falls back to a cold
      // snapshot forever, exactly as the port instructs, and never resumes again.
      const { adapter, roomId } = await arrange();
      const minted = await mintedCursorsFor(adapter, roomId);
      expect(minted.length, 'a room with entries mints cursors on both surfaces').toBeGreaterThan(
        0
      );

      for (const { cursor, source } of minted) {
        // Constructed, awaiting nothing — a refusal here is eager by contract,
        // so it lands on this line or not at all.
        expect(
          () => adapter.subscribeRoom(roomId, cursor),
          `subscribeRoom refused a cursor this adapter minted itself (${source})`
        ).not.toThrow();
        await expect(
          adapter.listEntries(roomId, { cursor }),
          `listEntries refused a cursor this adapter minted itself (${source})`
        ).resolves.toBeDefined();
      }
    });

    if (opts.seedEmptyRoom || declared.roomAdmin) {
      it('U17 accepts the cursor it minted for a room with nothing in it', async () => {
        // The one cursor an adapter mints nowhere else. A backend whose position
        // is a real address rather than a counter has to invent something for
        // "before the first entry", and whatever it invents is the value its own
        // reader has never been handed.
        const { adapter } = await arrange();
        const emptyRoomId = opts.seedEmptyRoom
          ? await opts.seedEmptyRoom(adapter)
          : (await adapter.createRoom({ title: `Empty ${Date.now()}` })).roomId;

        const iterator = adapter.subscribeRoom(emptyRoomId)[Symbol.asyncIterator]();
        let cursor;
        try {
          const first = await nextEvent(iterator, 'the empty room’s snapshot', eventTimeoutMs);
          expect(first.type).toBe('snapshot');
          if (first.type !== 'snapshot') return;
          expect(first.entries, 'the room was arranged with nothing in it').toEqual([]);
          cursor = first.cursor;
        } finally {
          await iterator.return?.();
        }

        expect(
          () => adapter.subscribeRoom(emptyRoomId, cursor),
          'an adapter must accept the cursor its own empty-room snapshot handed out'
        ).not.toThrow();
        await expect(
          adapter.listEntries(emptyRoomId, { cursor }),
          'and so must the paging surface'
        ).resolves.toBeDefined();
      });
    } else {
      it.skip('U17 empty-room cursor (no seedEmptyRoom hook, and this backend cannot create one)', () => {});
    }

    it('U18 emits entries in one order, and every surface it hands out agrees on it', async () => {
      // "Order is the adapter's emission order" is the invariant that replaced
      // `seq`, and nothing asserted it. A backend whose page walks one way and
      // whose replay walks the other is internally consistent on each surface
      // and shows a reader a conversation in two different orders.
      const { adapter, caps, roomId } = await arrange();
      // **A WIDE page, deliberately — the opposite of U8's page of one.** With a
      // page size of one, the order this walk returns is the order the CURSORS
      // step in, and the order inside a page is never observed at all: an
      // adapter that reversed every page it emits would satisfy this case
      // completely. One page holding every entry is the only read that puts the
      // adapter's own intra-page order in front of an assertion.
      const paged = (await pageAllEntries(adapter, roomId, WIDE_PAGE)).entries.map((e) => e.id);

      const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
      let replayed: string[] = [];
      try {
        const first = await nextEvent(iterator, 'the opening snapshot', eventTimeoutMs);
        if (first.type === 'snapshot') replayed = first.entries.map((e) => e.id);
      } finally {
        await iterator.return?.();
      }

      // Compared over what the two surfaces SHARE, because they legitimately
      // hold different sets: a page is top-level only, while a snapshot replays
      // thread replies too. What they may never do is disagree about the
      // relative order of an entry both of them carry.
      const inSnapshot = new Set(replayed);
      const inPage = new Set(paged);
      expect(
        paged.filter((id) => inSnapshot.has(id)),
        'a page and a replay must not order the same entries differently'
      ).toEqual(replayed.filter((id) => inPage.has(id)));

      if (!caps.canPost) return;
      // The half with GROUND TRUTH behind it: this suite knows which of these
      // two was written first, which nothing derived from the adapter's own
      // reads can know.
      const first = await adapter.post(roomId, { text: 'written first' });
      const second = await adapter.post(roomId, { text: 'written second' });
      const after = (await pageAllEntries(adapter, roomId, WIDE_PAGE)).entries.map((e) => e.id);
      expect(after, 'both posts must be readable').toContain(first.entryId);
      expect(
        after.indexOf(first.entryId),
        'history is oldest-first: what was said first'
      ).toBeLessThan(after.indexOf(second.entryId));
    });

    if (!declared.canPost) {
      it.skip('U19 mentions round-trip (this backend cannot post)', () => {});
    } else {
      it('U19 round-trips the mentions a writer resolved', async () => {
        // `PostCommunityEntryInput.mentions` is "member ids the writer
        // addressed", and `CommunityEntry.mentions` carries them back —
        // "because `responseMode: 'mention-only'` is unusable without it", which
        // is the port stating the consequence of losing them. An adapter that
        // accepts the field and drops it satisfies every other assertion here.
        const { adapter, roomId, identityMemberId } = await arrange();
        const posted = await adapter.post(roomId, {
          // Deliberately no `@` anywhere: a backend that resolves mentions by
          // scanning the text would pass with the field still on the floor.
          text: 'a line that names nobody in its own words',
          mentions: [identityMemberId],
        });

        const written = (await adapter.listEntries(roomId, { limit: 500 })).entries.find(
          (entry) => entry.id === posted.entryId
        );
        expect(written, 'the posted entry must be readable').toBeDefined();
        expect(
          written!.mentions,
          'a mention the writer resolved must survive the write, or nothing addresses anyone'
        ).toContain(identityMemberId);
      });

      it('U20 hands back a receipt cursor that resumes AFTER the entry it names', async () => {
        // `CommunityEntryRef.cursor` is "the cursor that resumes after it, so a
        // poster can subscribe without a round-trip". A receipt that resumes
        // BEFORE its own entry makes that round trip a duplicate; one that
        // resumes past the next entry loses it. Both look like a working cursor
        // to every other assertion in this file.
        const { adapter, roomId } = await arrange();
        const receipt = await adapter.post(roomId, { text: 'the entry the receipt names' });
        const next = await adapter.post(roomId, { text: 'the entry a resume must carry' });

        const iterator = adapter.subscribeRoom(roomId, receipt.cursor)[Symbol.asyncIterator]();
        try {
          const snapshot = await nextEvent(iterator, 'the resumed snapshot', eventTimeoutMs);
          expect(snapshot.type).toBe('snapshot');
          if (snapshot.type !== 'snapshot') return;
          const ids = snapshot.entries.map((entry) => entry.id);
          expect(ids, 'a resume from a receipt must carry what was written after it').toContain(
            next.entryId
          );
          expect(
            ids,
            'and must not replay the entry the receipt itself names — it resumes AFTER it'
          ).not.toContain(receipt.entryId);
        } finally {
          await iterator.return?.();
        }
      });
    }

    it('U21 hands out a capability declaration a consumer cannot change', async () => {
      // Capabilities decide what a caller may do, and every consumer reads them
      // through this one method. A declaration handed out by reference is one
      // stray `push` away from an adapter that says it can post because
      // something else mutated what it was given — and the mutation is
      // invisible, because the object still looks exactly like a declaration.
      const adapter = makeAdapter();
      const before = structuredClone(adapter.getCapabilities());
      const handed = adapter.getCapabilities();

      handed.canPost = !handed.canPost;
      handed.roomAdmin = !handed.roomAdmin;
      handed.roles.supported = !handed.roles.supported;
      handed.roles.values.push({ id: 'intruder', label: 'Intruder', administers: true });
      handed.features.intruder = true;

      expect(
        adapter.getCapabilities(),
        'a consumer holding a declaration must not be able to rewrite the next one'
      ).toEqual(before);
    });

    it('U22 refuses a cursor it did not mint, on BOTH surfaces that take one', async () => {
      assertImported(StaleCommunityCursorError, 'StaleCommunityCursorError');
      const { adapter } = await arrange();
      const roomA = await seedRoom(adapter);
      const roomB = await seedRoom(adapter);
      const foreign = (await pageAllEntries(adapter, roomA)).entries[0]!.cursor;

      // U7 asserts the streaming surface. This is the paging one, which takes a
      // cursor too and had nothing asserting it at all: an adapter that rejected
      // a foreign cursor on `subscribeRoom` and quietly bounded it on
      // `listEntries` passed the whole suite, while serving a page from the
      // wrong place in the wrong room.
      await expect(
        adapter.listEntries(roomB, { cursor: foreign }),
        'listEntries must reject a cursor from another room, not bound it'
      ).rejects.toBeInstanceOf(StaleCommunityCursorError);

      // A token this adapter cannot have minted at all. Whatever the encoding
      // is, "I do not recognise this" is a refusal and never a default position
      // at the start of the room.
      const nonsense = 'not-a-cursor-this-adapter-ever-minted' as CommunityCursor;
      expect(
        () => adapter.subscribeRoom(roomB, nonsense),
        'an unrecognisable cursor is refused at call time, like every other one'
      ).toThrow(StaleCommunityCursorError);
      await expect(
        adapter.listEntries(roomB, { cursor: nonsense }),
        'and refused on the paging surface too, rather than read as the beginning'
      ).rejects.toBeInstanceOf(StaleCommunityCursorError);
    });
  });

  /**
   * Every cursor a room hands out: the one its snapshot opens with, the one on
   * each entry, and the one a page declares to continue from.
   *
   * @param adapter - The adapter to read.
   * @param roomId - The room to collect from.
   */
  async function mintedCursorsFor(
    adapter: CommunityAdapter,
    roomId: string
  ): Promise<{ cursor: CommunityCursor; source: string }[]> {
    const minted: { cursor: CommunityCursor; source: string }[] = [];
    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
    try {
      const first = await nextEvent(iterator, 'the opening snapshot', eventTimeoutMs);
      if (first.type === 'snapshot') {
        minted.push({ cursor: first.cursor, source: 'the snapshot' });
        for (const entry of first.entries) {
          minted.push({ cursor: entry.cursor, source: `the entry '${entry.id}'` });
        }
      }
    } finally {
      await iterator.return?.();
    }

    const page = await adapter.listEntries(roomId, { limit: PAGE_SIZE });
    for (const entry of page.entries) {
      minted.push({ cursor: entry.cursor, source: `a paged entry '${entry.id}'` });
    }
    if (page.nextCursor !== null) {
      minted.push({ cursor: page.nextCursor, source: "a page's nextCursor" });
    }
    return minted;
  }
}
