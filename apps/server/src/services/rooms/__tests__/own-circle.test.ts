/**
 * Marks, not levels, between the owner's own agents (DOR-3107, Security). In
 * the owner's own circle a post KNOWN to be unmarked hands on no ceiling but the
 * cap a person set on its poster; a post nobody kept marks for, a marked post,
 * and every room outside the circle stay as they were.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { ceilingCarriesOutsider, resolveCeilingLevel } from '@dorkos/shared/permission-semantics';
import { noteEntryLevel, setEntryMarksStore } from '../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { createEntryMarksStore } from '../limits/entry-marks-store.js';
import { storedEntryHoldReader } from '../limits/stored-entry-hold.js';
import { ceilingForEntry } from '../limits/turn-ceiling.js';
import { isOwnCircle, posterCapsFor } from '../limits/own-circle.js';
import { agentLookupFor, createRoomHarness, type RoomHarness } from './room-test-harness.js';

const OWN = { ownCircle: true } as const;
const ACT = { asks: 'when-risky', reach: 'workspace' } as const;

/** A room context showing these entries and nothing else. */
function shown(
  entries: Array<{ id: string; kind?: string; authorIsPerson?: boolean; authorOrigin?: string }>
): Pick<RoomContextData, 'pending' | 'gathered' | 'channelTail'> {
  return {
    pending: entries.map((e) => ({ kind: 'post', authorIsPerson: false, ...e })),
  } as unknown as Pick<RoomContextData, 'pending' | 'gathered' | 'channelTail'>;
}

describe('own-circle room turns', () => {
  let harness: RoomHarness;
  let channel: RoomWithRoster;
  let bo: string;

  beforeEach(() => {
    harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
    });
    channel = harness.service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: ['/agents/bo'] },
      harness.human
    );
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    setEntryMarksStore(createEntryMarksStore(harness.db));
  });

  afterEach(() => setEntryMarksStore(null));

  /** A post by Bo whose level this process never kept, as after a restart. */
  function postByBo(marks?: Record<string, unknown>): { id: string; authorId: string } {
    const entry = harness.service.post(channel.id, { authorId: bo, text: 'checking the build' });
    if (marks) createEntryMarksStore(harness.db).write(channel.id, entry.id, marks);
    return entry;
  }

  // Security's test: an unmarked post read back after a restart wakes an agent
  // with no card.
  it('hands on no ceiling for a post known to be unmarked, read back after a restart', () => {
    const entry = postByBo({});
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({});
  });

  it('holds it to the cap a person set on the poster', () => {
    const entry = postByBo({});
    const circle = { ownCircle: true, posterCap: () => ACT };
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, circle)).toEqual({
      permissionCeiling: ACT,
    });
  });

  // Trust first (Dorian 2026-10-19): an own agent's post whose marks nobody
  // kept (a restart, an old row) is trusted; only a marked one caps.
  /** A post by Bo from before marks were kept: no row marks, no memory. */
  const oldPostByBo = () => ({ id: `old-${Math.random()}`, authorId: bo });

  it('trusts a post nobody kept marks for, in the circle', () => {
    const entry = oldPostByBo();
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({});
  });

  it('keeps a post nobody kept marks for at the default outside the circle', () => {
    const entry = oldPostByBo();
    expect(ceilingForEntry(harness.authors, entry, false, channel.id)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  // Review finding (DOR-3107): an agent's post over the HTTP routes names its
  // agent with a header nothing verifies, so it is kept as an outsider's.
  it('caps a post no verified session vouched for (the HTTP routes)', () => {
    const entry = harness.service.post(channel.id, { authorId: bo, text: 'from curl' }, true);
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('writes those marks with the post itself, so they survive a restart', () => {
    // No separate marks store: only the insert's own transaction can write them.
    setEntryMarksStore(null);
    const entry = harness.service.post(channel.id, { authorId: bo, text: 'from curl' }, true);
    // A fresh reader, as after a restart: only the row is left.
    expect(createEntryMarksStore(harness.db).read(channel.id, entry.id)).toEqual({
      outsider: true,
    });
  });

  // DOR-3037 on DOR-3107: a hold from Wi-Fi only lowers. The own circle never
  // reads a held post as trusted, whoever wrote it.
  it('keeps a person’s post from Wi-Fi at the default inside the circle', () => {
    const entry = harness.service.post(
      channel.id,
      { authorId: harness.human, text: 'from the phone' },
      false,
      'runtime-default'
    );
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('holds AND marks an unverified agent’s post from Wi-Fi, both on its row', () => {
    setEntryMarksStore(null);
    const entry = harness.service.post(
      channel.id,
      { authorId: bo, text: 'from curl on the phone' },
      true,
      'runtime-default'
    );
    expect(createEntryMarksStore(harness.db).read(channel.id, entry.id)).toEqual({
      outsider: true,
    });
    expect(storedEntryHoldReader(harness.db)(channel.id, entry.id)).toBe(true);
    expect(
      ceilingForEntry(harness.authors, entry, false, channel.id, {
        ...OWN,
        posterCap: () => ACT,
      })
    ).toEqual({ permissionCeiling: 'runtime-default' });
  });

  // Security's Should (DOR-3107): Codex and OpenCode call over the external
  // server with a verified agent token but no session. Their posts read like
  // an own agent's with an unknown level; only a caller with no identity is a
  // stranger's.
  it('trusts a verified agent with no session, and caps a caller with no identity', () => {
    const verified = harness.service.postFromTool(channel.id, {
      authorId: bo,
      text: 'from codex',
      callerAgentVerified: true,
    });
    expect(ceilingForEntry(harness.authors, verified, false, channel.id, OWN)).toEqual({});
    const unverified = harness.service.postFromTool(channel.id, {
      authorId: bo,
      text: 'from nobody',
    });
    expect(ceilingForEntry(harness.authors, unverified, false, channel.id, OWN)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('keeps a marked post capped, in the circle too', () => {
    const entry = postByBo({ outsider: true });
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  describe('a marked post whose poster ran at Full (DOR-3141)', () => {
    const FULL: TurnPermissionLevel = { asks: 'never', reach: 'everything' };
    /** Whether a turn under this ceiling would ask before a write: a card. */
    const asksBeforeWriting = (ceiling: { permissionCeiling?: unknown }): boolean =>
      ceiling.permissionCeiling !== undefined &&
      resolveCeilingLevel(
        CLAUDE_CODE_CAPABILITIES.permissionModes,
        ceiling.permissionCeiling as Parameters<typeof resolveCeilingLevel>[1]
      ).asks !== 'never';

    // DOR-3390: the mark rides on and gates the risky actions; the write itself runs at Full.
    it('marks the agent it wakes without capping it, in the circle and outside it', () => {
      const entry = harness.service.post(channel.id, { authorId: bo, text: '@hop write it' });
      noteEntryLevel(entry.id, { ...FULL, outsider: true }, channel.id);
      for (const ceiling of [
        ceilingForEntry(harness.authors, entry, false, channel.id, OWN),
        ceilingForEntry(harness.authors, entry, false, channel.id),
      ]) {
        expect(asksBeforeWriting(ceiling)).toBe(false);
        expect(ceilingCarriesOutsider(ceiling.permissionCeiling as never)).toBe(true);
      }
    });

    it('still makes it ask after a restart, from the marks kept on the row', () => {
      // No level in memory: only the row's marks survive a restart.
      const entry = postByBo({ outsider: true });
      expect(
        asksBeforeWriting(ceilingForEntry(harness.authors, entry, false, channel.id, OWN))
      ).toBe(true);
    });

    it('leaves an unmarked own-agent post at Full', () => {
      const entry = harness.service.post(channel.id, { authorId: bo, text: '@hop write it' });
      noteEntryLevel(entry.id, FULL, channel.id);
      expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({});
      expect(ceilingForEntry(harness.authors, entry, false, channel.id)).toEqual({
        permissionCeiling: FULL,
      });
    });
  });

  it('changes nothing outside the circle', () => {
    const entry = postByBo({});
    expect(ceilingForEntry(harness.authors, entry, false, channel.id)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  describe('isOwnCircle', () => {
    const plain = { inSpaceRoom: false, bridged: false };

    it('holds for a room of the owner and their own agents, with every post vouched for', () => {
      const entry = postByBo({});
      expect(isOwnCircle(shown([{ id: entry.id }]), channel.id, plain)).toBe(true);
    });

    it('fails in a space room or a bridged room', () => {
      const entry = postByBo({});
      const context = shown([{ id: entry.id }]);
      expect(isOwnCircle(context, channel.id, { inSpaceRoom: true, bridged: false })).toBe(false);
      expect(isOwnCircle(context, channel.id, { inSpaceRoom: false, bridged: true })).toBe(false);
    });

    it('fails with an outsider’s words in view', () => {
      const entry = postByBo({});
      const context = shown([{ id: entry.id }, { id: 'x', authorOrigin: 'external' }]);
      expect(isOwnCircle(context, channel.id, plain)).toBe(false);
    });

    it('holds with an own agent post in view that nobody kept marks for', () => {
      const vouched = postByBo({});
      const context = shown([{ id: vouched.id }, { id: 'old-row' }]);
      expect(isOwnCircle(context, channel.id, plain)).toBe(true);
    });

    it('ignores the owner’s own lines', () => {
      const entry = postByBo({});
      const context = shown([{ id: entry.id }, { id: 'p', authorIsPerson: true }]);
      expect(isOwnCircle(context, channel.id, plain)).toBe(true);
    });
  });

  it('reads each agent poster’s cap once, and none for a person', async () => {
    const entry = postByBo({});
    const read: string[] = [];
    const capOf = await posterCapsFor(
      harness.authors,
      [
        { ...entry, sessionId: 'bo-room-chat' },
        { ...entry, sessionId: 'bo-room-chat' },
        { authorId: harness.human },
      ],
      async (agentPath, sessionIds) => {
        read.push(`${agentPath} ${sessionIds.join(',')}`);
        return ACT;
      }
    );
    // Once per poster, with the conversation it wrote from, whose mode a person
    // may have set below the poster's own (review finding 2).
    expect(read).toEqual(['/agents/bo bo-room-chat']);
    expect(capOf(bo)).toEqual(ACT);
    expect(capOf(harness.human)).toBeUndefined();
  });
});
