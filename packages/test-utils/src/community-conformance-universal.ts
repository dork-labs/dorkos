/**
 * The universal half of the `CommunityAdapter` conformance suite: the fifteen
 * assertions every backend owes, with no branch and no opt-out.
 *
 * These are the properties that stay true whatever a backend declares — an
 * address that carries its own community, a snapshot before any entry, a resume
 * that is gap-free or refuses, exhaustion declared rather than inferred, stable
 * entry ids, honest attribution, a terminal event when a room goes away, and no
 * credential anywhere on the wire.
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
  CommunityRoomSchema,
  CommunityUnsupportedError,
  StaleCommunityCursorError,
} from '@dorkos/shared/community-adapter';
import {
  GATED_PROBES,
  PAGE_SIZE,
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
  });
}
