/**
 * The capability-branched half of the `CommunityAdapter` conformance suite.
 *
 * Every legitimate backend difference is a *declared* flag with a branched
 * assertion — never a weakened one. Both sides of each branch prove something:
 * a backend that can post proves its post lands and is attributed, and a
 * backend that cannot proves it refuses rather than dropping the write.
 *
 * @module test-utils/community-conformance-branched
 */
import { describe, expect, it } from 'vitest';
import {
  CommunityInviteSchema,
  CommunityMemberNotFoundError,
  CommunityMemberSchema,
  CommunityUnsupportedError,
  RoomAddressSchema,
  type CommunityCursor,
} from '@dorkos/shared/community-adapter';
import {
  QUIET_WINDOW_MS,
  drainQuietly,
  nextEvent,
  pageAllEntries,
  type CommunityConformanceContext,
} from './community-conformance-support.js';

/**
 * Register the assertions whose shape depends on what a backend declares.
 *
 * @param ctx - The suite's resolved hooks and helpers.
 */
export function registerCapabilityBranchedAssertions(ctx: CommunityConformanceContext): void {
  const { makeAdapter, arrange, awaitRoomEvent, eventTimeoutMs } = ctx;
  const { seedRoom, revokeOwner, makeUnadmittedAdapter, makeUnauthorizedAdapter } = ctx.opts;
  // Read once at REGISTRATION time so a case this backend cannot run registers a
  // named skip rather than returning green from inside the test body.
  const declared = makeAdapter().getCapabilities();

  describe('capability-branched', () => {
    it('C1 posts when canPost, and refuses when it does not', async () => {
      const { adapter, caps, roomId, identityMemberId } = await arrange();
      if (!caps.canPost) {
        await expect(adapter.post(roomId, { text: 'refused' })).rejects.toBeInstanceOf(
          CommunityUnsupportedError
        );
        return;
      }

      const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
      try {
        await nextEvent(iterator, 'the opening snapshot', eventTimeoutMs);
        const first = await adapter.post(roomId, { text: 'hello' });
        const live = await awaitRoomEvent(
          iterator,
          (e) => e.type === 'entry' && e.entry.id === first.entryId,
          'the posted entry arriving live'
        );
        expect(live.type).toBe('entry');
        if (live.type === 'entry') {
          expect(live.entry.authorId, 'a post is attributed to the connected identity').toBe(
            identityMemberId
          );
        }
        const second = await adapter.post(roomId, { text: 'hello again' });
        expect(second.entryId, 'two posts are two entries').not.toBe(first.entryId);
      } finally {
        await iterator.return?.();
      }
    });

    it('C2 round-trips create → rename → archive when roomAdmin, and refuses when it does not', async () => {
      const { adapter, caps, roomId } = await arrange();
      if (!caps.roomAdmin) {
        await expect(adapter.createRoom({ title: 'refused' })).rejects.toBeInstanceOf(
          CommunityUnsupportedError
        );
        await expect(adapter.updateRoom(roomId, { title: 'refused' })).rejects.toBeInstanceOf(
          CommunityUnsupportedError
        );
        return;
      }

      const created = await adapter.createRoom({ title: 'Planning' });
      expect(RoomAddressSchema.safeParse(created).success).toBe(true);
      expect(created.community).toBe(adapter.community);

      const renamed = await adapter.updateRoom(created.roomId, { title: 'Planning v2' });
      expect(renamed.title).toBe('Planning v2');

      const archived = await adapter.updateRoom(created.roomId, { archived: true });
      expect(archived.archived, 'archiving is a state, not an error').toBe(true);
      await expect(
        adapter.getRoom(created.roomId),
        'an archived room still reads'
      ).resolves.not.toBeNull();
    });

    it('C3 gives every member a declared role, or gives none a role at all', async () => {
      const { adapter, caps, roomId } = await arrange();
      const members = await adapter.listMembers(roomId);
      if (caps.roles.supported) {
        const declaredRoleIds = caps.roles.values.map((r) => r.id);
        for (const member of members) {
          if (member.role === null) continue;
          expect(declaredRoleIds, `role '${member.role}' is not declared`).toContain(member.role);
        }
        expect(
          caps.roles.values.filter((r) => r.isOwner === true).length,
          'at most one role holds the database'
        ).toBeLessThanOrEqual(1);
      } else {
        for (const member of members) {
          expect(member.role, 'a backend with no roles reports none').toBeNull();
        }
      }
    });

    it('C4/C5/C6 honours its read-cursor model, including the unread count it can honestly give', async () => {
      const { adapter, caps, roomId } = await arrange();

      if (caps.readCursor === 'none') {
        await expect(adapter.getReadCursor(roomId)).rejects.toBeInstanceOf(
          CommunityUnsupportedError
        );
        await expect(
          adapter.setReadCursor(roomId, 'anything' as CommunityCursor)
        ).rejects.toBeInstanceOf(CommunityUnsupportedError);
        return;
      }

      const { entries } = await pageAllEntries(adapter, roomId);
      const target = entries.at(-1)!.cursor;
      await adapter.setReadCursor(roomId, target);
      await expect(
        adapter.getReadCursor(roomId),
        'a read cursor round-trips for the identity that set it'
      ).resolves.toBe(target);

      const rooms = await adapter.listRooms();
      if (caps.readCursor === 'server') {
        const room = rooms.find((r) => r.roomId === roomId)!;
        expect(typeof room.unreadCount, 'a server-side cursor can compute an unread count').toBe(
          'number'
        );
      } else {
        for (const room of rooms) {
          expect(
            room.unreadCount,
            'a client-opaque cursor makes a server-computed unread count impossible — null, never 0'
          ).toBeNull();
        }
      }
    });

    it('C7/C8/C9 offers exactly the invite scope it declares, and refuses to widen', async () => {
      const { adapter, caps, roomId } = await arrange();

      if (caps.invite === 'none') {
        await expect(adapter.createInvite({})).rejects.toBeInstanceOf(CommunityUnsupportedError);
        await expect(adapter.createInvite({ roomId })).rejects.toBeInstanceOf(
          CommunityUnsupportedError
        );
        return;
      }

      if (caps.invite === 'room') {
        const invite = await adapter.createInvite({ roomId });
        expect(CommunityInviteSchema.safeParse(invite).success).toBe(true);
        expect(invite.roomId, 'a room-scoped invite is scoped to that room').toBe(roomId);
        expect(invite.community).toBe(adapter.community);
        return;
      }

      const invite = await adapter.createInvite({});
      expect(CommunityInviteSchema.safeParse(invite).success).toBe(true);
      expect(invite.roomId, 'a community invite admits to the community, not a room').toBeNull();
      // The sharpest assertion in the suite: no silent widening, and no
      // substituting "an admin adds you" — different acts, different consent.
      await expect(
        adapter.createInvite({ roomId }),
        'a community-scoped backend must REFUSE a room-scoped invite rather than widen it'
      ).rejects.toBeInstanceOf(CommunityUnsupportedError);
    });

    it('C10 admits an agent under its own identity, vouched and never administering', async () => {
      const { adapter, caps, identityMemberId } = await arrange();
      if (caps.agentAdmission === 'none') {
        await expect(
          adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' })
        ).rejects.toBeInstanceOf(CommunityUnsupportedError);
        await expect(adapter.revokeAgent('a1')).rejects.toBeInstanceOf(CommunityUnsupportedError);
        return;
      }

      const agent = await adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' });
      expect(CommunityMemberSchema.safeParse(agent).success).toBe(true);
      // P1 — a distinct member, not its owner wearing a hat.
      expect(agent.memberId, 'an agent is a distinct member from its owner').not.toBe(
        identityMemberId
      );
      // P2 — vouched by the connected identity.
      expect(agent.ownerMemberId, 'the vouch names the connected identity').toBe(identityMemberId);
      // P3 — capability never flows owner → agent.
      const role = caps.roles.values.find((r) => r.id === agent.role);
      expect(
        role?.administers ?? false,
        "an agent's role never administers, whatever its owner's role is"
      ).toBe(false);

      const again = await adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' });
      expect(again.memberId, 'admitting the same agent twice mints one identity').toBe(
        agent.memberId
      );
      await expect(adapter.revokeAgent(agent.memberId)).resolves.toBeUndefined();
      await expect(
        adapter.revokeAgent(agent.memberId),
        'revocation is idempotent'
      ).resolves.toBeUndefined();
    });

    if (declared.agentAdmission === 'none') {
      it.skip('C10/P4 derived agent admission (this backend cannot admit agents)', () => {});
    } else if (revokeOwner) {
      it('C10/P4 derives an agent’s admission from its owner, re-evaluated on use', async () => {
        const { adapter, identityMemberId } = await arrange();

        const agent = await adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' });
        expect(agent.ownerMemberId).toBe(identityMemberId);

        await revokeOwner(adapter, identityMemberId);

        // Asserted BY USE, not by a row disappearing: admission is derived and
        // re-evaluated, never copied into a row a cleanup job must find.
        await expect(
          adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' }),
          'removing the human removes their agents'
        ).rejects.toThrow();
      });
    } else {
      it.skip('C10/P4 derived agent admission (no revokeOwner hook supplied)', () => {});
    }

    it('C11/C12 enforces exactly the thread depth it declares', async () => {
      const { adapter, caps, roomId } = await arrange();
      const { entries } = await pageAllEntries(adapter, roomId);
      // Top-level entries are depth 0 by definition, so reading only them would
      // assert nothing about a ceiling. The real check is on a reply, below.
      for (const entry of entries) {
        expect(entry.depth, 'a top-level entry is depth 0').toBe(0);
      }
      if (!caps.canPost) return;

      const root = entries[0]!;
      const reply = await adapter.post(roomId, { text: 'reply', parentEntryId: root.id });

      if (caps.threadDepth === 1) {
        // The one-level ceiling, exercised on entries that actually have depth:
        // every reply in the thread reports depth 1, and a reply to one of them
        // is refused rather than flattened back to level one.
        const thread = await adapter.listEntries(roomId, { thread: root.id, limit: 500 });
        expect(
          thread.entries.map((e) => e.id),
          'the reply must be readable as part of its thread'
        ).toContain(reply.entryId);
        for (const entry of thread.entries) {
          expect(entry.depth, 'a one-level backend never reports a deeper entry').toBe(1);
          expect(entry.threadRootEntryId, 'and every reply hangs off the root').toBe(root.id);
        }
        await expect(
          adapter.post(roomId, { text: 'reply to a reply', parentEntryId: reply.entryId }),
          'a one-level backend refuses a reply to a reply rather than flattening it'
        ).rejects.toThrow();
        return;
      }

      await adapter.post(roomId, { text: 'reply to a reply', parentEntryId: reply.entryId });
      const thread = await adapter.listEntries(roomId, { thread: root.id, limit: 500 });
      expect(
        thread.entries.some((e) => e.depth > 1),
        'an unbounded backend keeps ancestry past level one'
      ).toBe(true);
    });

    it('C13/C14 reports a new room on the room-list stream, whether it pushes or polls', async () => {
      const { adapter, caps } = await arrange();
      const budget =
        caps.roomList === 'poll'
          ? Math.max(eventTimeoutMs, (caps.roomListPollIntervalMs ?? 0) * 10)
          : eventTimeoutMs;

      const iterator = adapter.subscribeRoomList()[Symbol.asyncIterator]();
      try {
        const seeded = await seedRoom(adapter);
        const deadline = Date.now() + budget;
        let found = false;
        while (!found && Date.now() < deadline) {
          const event = await nextEvent(
            iterator,
            `room_added for '${seeded}' (${caps.roomList})`,
            Math.max(1, deadline - Date.now())
          );
          found = event.type === 'room_added' && event.room.roomId === seeded;
          if (event.type === 'room_added') {
            expect(event.room.community).toBe(adapter.community);
          }
        }
        expect(
          found,
          'the shape is identical whether an adapter pushes or polls; only latency differs'
        ).toBe(true);
      } finally {
        await iterator.return?.();
      }
    });

    it('C15 round-trips a presence signal when it has signals, and yields none when it does not', async () => {
      const { adapter, caps, roomId, identityMemberId } = await arrange();

      if (caps.signals === 'none') {
        // The stream exists here only to be watched: the refusal is half the
        // branch, and "nothing was yielded either" is the other half.
        const quiet = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
        try {
          await nextEvent(quiet, 'the opening snapshot', eventTimeoutMs);
          await expect(adapter.publishSignal(roomId, 'typing')).rejects.toBeInstanceOf(
            CommunityUnsupportedError
          );
          const seen = await drainQuietly(quiet, QUIET_WINDOW_MS);
          expect(
            seen.filter((e) => e.type === 'signal'),
            'a signal-less adapter never yields a signal'
          ).toEqual([]);
        } finally {
          await quiet.return?.();
        }
        return;
      }

      // A REAL entry, because `entryId` is the field that says which question
      // is being worked on: an indicator keyed on a fabricated id would render
      // against nothing, and an adapter that dropped the field would pass an
      // assertion written around a value nobody could check.
      const before = await adapter.listEntries(roomId);
      const payload = {
        state: 'working' as const,
        memberId: identityMemberId,
        entryId: before.entries[0]!.id,
        since: '2026-07-29T00:00:00.000Z',
      };

      // The SECOND subscription is the point: a signal that only reaches the
      // stream its publisher happens to hold is not fan-out, and presence is
      // for the people who are not the one working.
      const observer = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
      try {
        await nextEvent(observer, "the observer's opening snapshot", eventTimeoutMs);
        await adapter.publishSignal(roomId, 'progress', payload);
        const event = await awaitRoomEvent(
          observer,
          (e) => e.type === 'signal',
          'the published signal'
        );
        expect(event.type).toBe('signal');
        if (event.type === 'signal') {
          expect(event.signal).toBe('progress');
          expect(event.memberId, 'the frame says who emitted it').toBe(identityMemberId);
          expect(
            event.payload,
            'the presence payload arrives intact, every field of it — a signal that cannot say what it means is a cleared throat'
          ).toEqual(payload);
        }
      } finally {
        await observer.return?.();
      }

      // "Live only; never durable", in the one direction a port-level suite
      // can see it: a signal must not become an entry, and a subscription
      // opened AFTER the publish must not be told about it. A backend that
      // wrote the payload into a private table nobody can read through the
      // port is invisible here, and the suite's module doc says so rather than
      // implying this covers it.
      const after = await adapter.listEntries(roomId);
      expect(
        after.entries.map((entry) => entry.id),
        'a signal never enters the log'
      ).toEqual(before.entries.map((entry) => entry.id));
      const latecomer = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
      try {
        const snapshot = await nextEvent(latecomer, "the latecomer's snapshot", eventTimeoutMs);
        expect(snapshot.type).toBe('snapshot');
        const replayed = await drainQuietly(latecomer, QUIET_WINDOW_MS);
        expect(
          replayed.filter((e) => e.type === 'signal'),
          'a signal published before a subscription existed is gone, not replayed'
        ).toEqual([]);
      } finally {
        await latecomer.return?.();
      }
    });

    it('C15a passes a backend that only ever says working and done', async () => {
      const { adapter, caps, roomId, identityMemberId } = await arrange();

      if (caps.signals === 'none') {
        // Covered by C15's own off-branch; there is nothing to publish here.
        return;
      }

      // **The presence lifecycle grew a member and this asserts it stayed
      // additive.** `held` says a message is waiting on a turn the agent is
      // running somewhere else — a fact only a backend that owns the claim can
      // know, and one a remote community may have no notion of at all. So the
      // port requires nothing of it: a backend that publishes `working` then
      // `done` and never anything in between is complete, and adding a case that
      // demanded more would fail a correct backend. Red if `held` ever becomes
      // required, or if the payload gains a required field beside it.
      const before = await adapter.listEntries(roomId);
      const entryId = before.entries[0]!.id;
      const observer = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
      try {
        await nextEvent(observer, "the observer's opening snapshot", eventTimeoutMs);
        for (const state of ['working', 'done'] as const) {
          await adapter.publishSignal(roomId, 'progress', {
            state,
            memberId: identityMemberId,
            entryId,
            since: '2026-08-18T00:00:00.000Z',
          });
          const event = await awaitRoomEvent(
            observer,
            (e) => e.type === 'signal',
            `the ${state} signal`
          );
          expect(event.type === 'signal' && event.payload?.state).toBe(state);
        }
      } finally {
        await observer.return?.();
      }
    });

    if (declared.credential === 'machine-managed') {
      it('C16 connects with no configuration step in between', async () => {
        // The mechanical form of "nothing to write down and nothing to lose":
        // construct, then connect. No hook runs between the two, so if this
        // reaches 'connected' there was no operator step a test could have
        // performed on the person's behalf — the credential was minted and used
        // without anyone being told about it.
        //
        // Asserting the terminal STATUS ('any of the four') would have asserted
        // nothing: the type is that union, so every legal return value passes.
        // `makeAdapter` is contracted to return a ready-to-use adapter, which is
        // what makes 'connected' the answer a conforming machine-managed backend
        // owes here — and what makes an adapter that cannot mint its own
        // credential fail.
        const fresh = makeAdapter();
        const connection = await fresh.connect();
        expect(
          connection.status,
          "a machine-managed adapter mints its own credential and connects with it — no setup step, so 'connected' is the only outcome a ready fixture can honestly reach"
        ).toBe('connected');
        expect(connection.identity, 'and it knows who it connected as').toBeDefined();
      });
    } else {
      it.skip('C16 machine-managed zero-setup connect (this backend declares a different credential model)', () => {});
    }

    if (makeUnadmittedAdapter) {
      it('C17 tells "not admitted" apart from "bad credential", with a plain-language next step', async () => {
        const adapter = makeUnadmittedAdapter();
        const connection = await adapter.connect();
        expect(
          connection.status,
          'collapsing these tells a person to fix a key they cannot see'
        ).toBe('not-admitted');
        expect(
          connection.disclosure,
          "'not-admitted' REQUIRES a plain-language what-happens-next"
        ).toBeTruthy();
        expect(connection.identity, 'an unadmitted connection has no identity').toBeUndefined();
      });
    } else {
      it.skip("C17 'not-admitted' branch (no makeUnadmittedAdapter hook supplied)", () => {});
    }

    if (makeUnauthorizedAdapter) {
      it('C17 reports a rejected credential as unauthorized, not as not-admitted', async () => {
        const adapter = makeUnauthorizedAdapter();
        const connection = await adapter.connect();
        expect(connection.status).toBe('unauthorized');
        expect(connection.error).toBeTruthy();
      });
    } else {
      it.skip("C17 'unauthorized' branch (no makeUnauthorizedAdapter hook supplied)", () => {});
    }

    it('C18 round-trips a per-room addressing override, or refuses and carries none', async () => {
      const { adapter, caps, roomId, identityMemberId } = await arrange();
      if (!caps.responseMode) {
        await expect(
          adapter.setResponseMode(roomId, identityMemberId, 'silent')
        ).rejects.toBeInstanceOf(CommunityUnsupportedError);
        for (const member of await adapter.listMembers(roomId)) {
          expect(
            member.responseMode,
            'a backend with no addressing override carries none on its members'
          ).toBeUndefined();
        }
        return;
      }

      const updated = await adapter.setResponseMode(roomId, identityMemberId, 'silent');
      expect(updated.responseMode).toBe('silent');
      const members = await adapter.listMembers(roomId);
      expect(
        members.find((m) => m.memberId === identityMemberId)?.responseMode,
        'the override appears on the roster, not only on the write'
      ).toBe('silent');
    });

    if (declared.responseMode) {
      it('C19 refuses an addressing override for a member this room has nobody for', async () => {
        const { adapter, roomId } = await arrange();
        // The port's own typed refusal, not a backend-native error with a `.code`
        // an out-of-process consumer could only duck-type. The id is fabricated,
        // so "unknown" and "known but not in this room" are the same case here —
        // which is the point: the refusal carries no reason to tell them apart.
        await expect(
          adapter.setResponseMode(roomId, 'nobody-this-community-minted', 'silent')
        ).rejects.toBeInstanceOf(CommunityMemberNotFoundError);
      });
    } else {
      it.skip('C19 member-not-found refusal (this backend has no addressing override)', () => {});
    }
  });
}
