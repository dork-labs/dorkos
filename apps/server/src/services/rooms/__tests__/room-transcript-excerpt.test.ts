/**
 * Tests for the room transcript excerpt (DOR-2108).
 *
 * The pure builder carries the bounding and the scrubbing, so it is tested
 * directly. The gathering wrapper is tested against a stubbed room service for
 * the one thing it adds: it reads as the reporter, so a room they cannot see
 * yields nothing rather than an error or somebody else's words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import {
  ROOM_TRANSCRIPT_MAX_LEN,
  ROOM_TRANSCRIPT_MAX_MESSAGES,
} from '@dorkos/shared/telemetry-events';

const listEntries = vi.fn();
const getById = vi.fn();

vi.mock('../index.js', () => ({
  getRoomService: () => ({ listEntries, authorRegistry: { getById } }),
}));

import {
  buildRoomTranscriptExcerpt,
  getRoomTranscriptExcerpt,
} from '../messages/room-transcript-excerpt.js';

/** A minimal room entry with the fields the excerpt reads. */
function entry(seq: number, authorId: string, text: string, extra: Partial<RoomEntry> = {}) {
  return {
    roomId: 'room-1',
    seq,
    id: `entry-${seq}`,
    authorId,
    kind: 'post',
    body: { text },
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    signature: null,
    createdAt: '2026-10-30T12:00:00.000Z',
    ...extra,
  } as RoomEntry;
}

const names: Record<string, string> = { a: 'Sam', b: 'Helper Bot' };
const nameOf = (id: string) => names[id];

describe('buildRoomTranscriptExcerpt', () => {
  it('returns undefined for an empty room', () => {
    expect(buildRoomTranscriptExcerpt([], nameOf)).toBeUndefined();
  });

  it('names each message by its author, oldest first', () => {
    const out = buildRoomTranscriptExcerpt(
      [entry(1, 'a', 'the board is empty'), entry(2, 'b', 'checking now')],
      nameOf
    );
    expect(out).toBe('Sam: the board is empty\n\nHelper Bot: checking now');
  });

  it('marks the room’s own notices and an author it cannot name', () => {
    const out = buildRoomTranscriptExcerpt(
      [
        entry(1, 'gone', 'hello?'),
        entry(2, 'system', 'Helper Bot’s turn failed.', { kind: 'notice' }),
      ],
      nameOf
    );
    expect(out).toContain('Someone: hello?');
    expect(out).toContain('[room notice] Helper Bot’s turn failed.');
  });

  it('counts attachments without naming the files', () => {
    const out = buildRoomTranscriptExcerpt(
      [
        entry(1, 'a', 'see this', {
          attachments: [{ id: 'f1' }, { id: 'f2' }] as RoomEntry['attachments'],
        }),
      ],
      nameOf
    );
    expect(out).toBe('Sam: see this [2 attachments]');
  });

  it('keeps only the latest messages', () => {
    const entries = Array.from({ length: ROOM_TRANSCRIPT_MAX_MESSAGES + 5 }, (_, i) =>
      entry(i + 1, 'a', `message ${i + 1}`)
    );
    const out = buildRoomTranscriptExcerpt(entries, nameOf) ?? '';
    expect(out).not.toContain('message 5\n');
    expect(out.startsWith('Sam: message 6\n')).toBe(true);
    expect(out.endsWith(`message ${ROOM_TRANSCRIPT_MAX_MESSAGES + 5}`)).toBe(true);
  });

  it('keeps the NEWEST text when the excerpt runs past the cap', () => {
    const long = 'x'.repeat(3_000);
    const out =
      buildRoomTranscriptExcerpt(
        [
          entry(1, 'a', `first ${long}`),
          entry(2, 'a', `middle ${long}`),
          entry(3, 'a', `last ${long}`),
        ],
        nameOf
      ) ?? '';
    expect(out.length).toBe(ROOM_TRANSCRIPT_MAX_LEN);
    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('last ');
    expect(out).not.toContain('first ');
  });

  it('scrubs home paths and secret-shaped tokens', () => {
    const out =
      buildRoomTranscriptExcerpt(
        [
          entry(
            1,
            'a',
            'it broke in /Users/sam/projects/app with key sk-ant-abcdefghijklmnopqrstuvwxyz0123'
          ),
        ],
        nameOf
      ) ?? '';
    expect(out).not.toContain('/Users/sam');
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
  });
});

describe('getRoomTranscriptExcerpt', () => {
  beforeEach(() => {
    listEntries.mockReset();
    getById.mockReset();
  });

  it('reads that one room as the reporter, and names authors from the registry', async () => {
    listEntries.mockReturnValue([entry(1, 'a', 'hi')]);
    getById.mockImplementation((id: string) => (id === 'a' ? { displayName: 'Sam' } : null));
    await expect(getRoomTranscriptExcerpt('room-1', 'viewer-1')).resolves.toBe('Sam: hi');
    expect(listEntries).toHaveBeenCalledWith('room-1', 'viewer-1', {
      limit: ROOM_TRANSCRIPT_MAX_MESSAGES,
    });
  });

  it('attaches nothing when the reporter cannot see the room', async () => {
    listEntries.mockImplementation(() => {
      throw new Error('not a member');
    });
    await expect(getRoomTranscriptExcerpt('room-1', 'viewer-1')).resolves.toBeUndefined();
  });
});
