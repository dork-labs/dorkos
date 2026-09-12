/**
 * The wire shapes a room's shared canvas travels on (spec `room-canvas` §2).
 *
 * Four properties, each of which is a live defect somewhere else if it breaks:
 *
 * - **The `canvas` frame carries no `seq`.** That is the exact mistake the
 *   ideation proposed and the code forbids: the room stream has ONE cursor, the
 *   highest durable entry a reader holds, and a second number in it makes a
 *   client that packs it wrong skip real messages. Asserted structurally, not by
 *   reading a comment.
 * - **The union stayed open at the other end.** Adding a fourth member must not
 *   narrow `entry`, `signal` or `reaction`.
 * - **Every addition is optional or additive**, so an older client parses a
 *   newer server's frames and an older entry still parses under the new body.
 * - **`applied` on a `ui_command` is optional**, because the event a codex or a
 *   scripted turn produces carries none and the tap keys its dedupe on exactly
 *   that absence.
 *
 * @module shared/tests/room-canvas-schemas
 */
import { describe, it, expect } from 'vitest';
import {
  CanvasDocumentSchema,
  RoomCanvasChangeSchema,
  RoomCanvasEventSchema,
  RoomEntryBodySchema,
  RoomEventSchema,
  RoomSnapshotSchema,
} from '../room-schemas.js';
import { UiCommandEventSchema, UiCommandSchema } from '../schemas.js';

/** The room a snapshot is about, with every field the roster view requires. */
const room = {
  id: 'general',
  kind: 'channel' as const,
  slug: 'general',
  title: '#general',
  topic: null,
  archived: false,
  wellKnown: null,
  fallbackSeatAuthorId: null,
  bridge: null,
  createdAt: '2026-09-11T09:00:00.000Z',
  lastActivityAt: '2026-09-11T10:00:00.000Z',
  members: [],
  ambientMaxEntries: 20,
  viewerAuthorId: 'author-ana',
  reactionFrequents: ['\u2705', '\ud83d\udc4d', '\ud83d\udc40'],
};

/** A whole canvas document, as a frame carries it. */
const document = {
  id: 'doc-1',
  scope: 'room:general',
  roomId: 'general',
  content: { type: 'url' as const, url: 'https://example.test/' },
  title: 'example.test',
  contentType: 'url',
  authorId: 'author-ana',
  pinned: false,
  rev: 3,
  lastTouchedBy: 'author-ana',
  lastTouchedAt: '2026-09-11T10:00:00.000Z',
  openedAt: '2026-09-11T09:00:00.000Z',
  lastActiveAt: '2026-09-11T10:00:00.000Z',
};

describe('the canvas frame', () => {
  it('parses a whole-document frame off the room stream', () => {
    const parsed = RoomEventSchema.parse({
      type: 'canvas',
      documentId: 'doc-1',
      document,
      change: 'opened',
    });
    expect(parsed.type).toBe('canvas');
  });

  it('parses a close as an id and nothing else', () => {
    // A close is a DELETION, so the id IS the payload — there is no row left to
    // describe. Every viewer drops the document on this.
    const parsed = RoomCanvasEventSchema.parse({
      type: 'canvas',
      documentId: 'doc-1',
      closed: true,
    });
    expect(parsed.document).toBeUndefined();
    expect(parsed.closed).toBe(true);
  });

  it('carries NO seq — the room stream has exactly one cursor', () => {
    // Structural, not a convention: `seq` must not be a declared member, and a
    // producer that sent one must not have it survive the parse into something
    // a reader could mistake for a cursor.
    expect('seq' in RoomCanvasEventSchema.shape).toBe(false);
    const parsed = RoomCanvasEventSchema.parse({
      type: 'canvas',
      documentId: 'doc-1',
      document,
      seq: 42,
    });
    expect(parsed).not.toHaveProperty('seq');
  });

  it('leaves the three frames that were already on the stream alone', () => {
    expect(
      RoomEventSchema.parse({
        type: 'reaction',
        entryId: 'entry-1',
        reactions: [],
      }).type
    ).toBe('reaction');
    expect(
      RoomEventSchema.parse({
        type: 'signal',
        signal: 'typing',
        authorId: 'author-ana',
        at: '2026-09-11T10:00:00.000Z',
      }).type
    ).toBe('signal');
  });

  it('refuses a frame naming no document', () => {
    expect(RoomCanvasEventSchema.safeParse({ type: 'canvas', documentId: '' }).success).toBe(false);
  });
});

describe('the document a frame carries', () => {
  it('keeps the edit lock and the source label optional', () => {
    const parsed = CanvasDocumentSchema.parse(document);
    expect(parsed.editingBy).toBeUndefined();
    expect(parsed.sourceLabel).toBeUndefined();
  });

  it('validates the content against the canvas union rather than waving it through', () => {
    expect(
      CanvasDocumentSchema.safeParse({ ...document, content: { type: 'not-a-thing' } }).success
    ).toBe(false);
  });
});

describe('the coalesced entry body', () => {
  it('accepts a canvas change beside moment and merge', () => {
    const body = RoomEntryBodySchema.parse({
      text: 'Ana opened the diff of src/router.ts.',
      canvas: {
        ops: [{ change: 'opened', documentId: 'doc-1', type: 'diff', title: 'src/router.ts' }],
      },
    });
    expect(body.canvas?.ops).toHaveLength(1);
  });

  it('still parses an entry written before the field existed', () => {
    // Additive, or every entry already in every room's log stops parsing.
    const body = RoomEntryBodySchema.parse({ text: 'hello' });
    expect(body.canvas).toBeUndefined();
  });

  it('refuses a canvas body that names no operation', () => {
    // "One entry per turn that changed something" is the rule; an entry with an
    // empty list would be the room announcing that nothing happened.
    expect(RoomCanvasChangeSchema.safeParse({ ops: [] }).success).toBe(false);
  });
});

describe('the cold-connect snapshot', () => {
  it('hydrates the whole table in one frame', () => {
    const snapshot = RoomSnapshotSchema.parse({
      room,
      entries: [],
      cursor: 0,
      canvas: [document],
    });
    expect(snapshot.canvas).toHaveLength(1);
  });

  it('still parses a snapshot from a producer that has no canvas', () => {
    const snapshot = RoomSnapshotSchema.parse({
      room,
      entries: [],
      cursor: 0,
    });
    expect(snapshot.canvas).toBeUndefined();
  });
});

describe('naming a document on the two verbs that had no referent', () => {
  it('accepts an update aimed at one document', () => {
    const command = UiCommandSchema.parse({
      action: 'update_canvas',
      content: { type: 'json', data: { ok: true } },
      documentId: 'doc-1',
    });
    expect(command).toMatchObject({ action: 'update_canvas', documentId: 'doc-1' });
  });

  it('accepts a close aimed at one document, and one aimed at none', () => {
    expect(UiCommandSchema.parse({ action: 'close_canvas', documentId: 'doc-1' })).toMatchObject({
      documentId: 'doc-1',
    });
    // Absent is today's session behaviour, unchanged. Additive means additive.
    expect(UiCommandSchema.parse({ action: 'close_canvas' })).toEqual({ action: 'close_canvas' });
  });
});

describe('the applied stamp', () => {
  it('is optional — an unstamped event is what the tap acts on', () => {
    const event = UiCommandEventSchema.parse({
      command: { action: 'close_canvas' },
    });
    expect(event.applied).toBeUndefined();
  });

  it('carries the document and revision the handler wrote', () => {
    const event = UiCommandEventSchema.parse({
      command: { action: 'close_canvas' },
      applied: { documentId: 'doc-1', rev: 7 },
    });
    expect(event.applied).toEqual({ documentId: 'doc-1', rev: 7 });
  });
});
