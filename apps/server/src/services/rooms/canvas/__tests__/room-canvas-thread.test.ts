/**
 * Talking about one document — the thread a canvas tab opens, and what a turn
 * inside it is told (spec `canvas-agent-seat` §7).
 *
 * Four properties:
 *
 * - **One thread per document, for everybody, for ever.** The first Discuss
 *   posts a root and writes its id onto the row; every Discuss after that hands
 *   back what is there. The column is what makes that survive a restart and hold
 *   across members, so it is asserted on the row rather than on a return value.
 * - **Both halves land, or neither does.** The entry and the column are written
 *   in one transaction, so a failure at the column leaves no entry behind.
 * - **It wakes nobody.** The root addresses no one and is never dispatched, so a
 *   plain reply in the thread starts no turn either — which is what keeps ADR
 *   `260911-200302` true of discussions as well as of canvas writes.
 * - **A turn in the thread is told about that document and no other**, still as
 *   labels: titles, types, authors and timestamps, never contents.
 *
 * Seeded defects, each run red before the code stood: returning a fresh root
 * from the second Discuss reddens "opens the thread that is already there";
 * writing the column outside the transaction reddens "leaves no entry behind";
 * dropping the narrowing in `canvasContextFor` reddens "narrows a thread turn".
 *
 * @module server/services/rooms/canvas/tests/room-canvas-thread
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { canvasDocuments, eq } from '@dorkos/db';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  settleUntil,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';

const ANA = '/agents/ana';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

describe('a canvas document’s discussion', () => {
  let harness: RoomHarness;
  let roomId: string;
  let owner: string;
  let ana: string;
  /** The document everybody is talking about. */
  let documentId: string;

  beforeEach(() => {
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => 'on it') });
    owner = harness.human;
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      owner
    ).id;
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;
    documentId = harness.service.canvas.open(roomId, owner, {
      type: 'json',
      data: { hello: 'room' },
      title: 'the plan',
    }).id;
  });

  /** What the row itself says about this document's thread. */
  const storedThreadRoot = (): string | null =>
    harness.db
      .select({ threadRootEntryId: canvasDocuments.threadRootEntryId })
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, documentId))
      .get()?.threadRootEntryId ?? null;

  /** Every entry the room holds, oldest first. */
  const entries = () => harness.service.readHistory(roomId, owner, { limit: 100 });

  it('posts one root naming the document and records it on the row', () => {
    const before = entries().length;
    const thread = harness.service.canvas.discuss(roomId, owner, documentId);

    expect(thread.created).toBe(true);
    expect(storedThreadRoot()).toBe(thread.threadRootEntryId);

    const added = entries().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe(thread.threadRootEntryId);
    // The document by its own title — what the person pressing Discuss was
    // looking at, and what everybody else sees on the tab.
    expect(added[0].body.text).toContain('the plan');
    // System-voiced, addressing nobody: the emptiness is the mechanism.
    expect(added[0].authorId).not.toBe(owner);
    expect(added[0].mentions).toEqual([]);
  });

  it('opens the thread that is already there, and posts nothing', () => {
    const first = harness.service.canvas.discuss(roomId, owner, documentId);
    const before = entries().length;

    // A different member, which is the case the column exists for: the answer
    // cannot come from anything this browser remembers.
    const second = harness.service.canvas.discuss(roomId, ana, documentId);

    expect(second).toEqual({ threadRootEntryId: first.threadRootEntryId, created: false });
    expect(entries()).toHaveLength(before);
  });

  it('leaves no entry behind when the column cannot be written', () => {
    // Both halves or neither. The failure is seeded at the column, which is the
    // half that runs INSIDE the entry's transaction — so an entry that survived
    // it would be a root nothing points at, and the next Discuss would start a
    // second thread on the same document.
    const store = harness.service.canvas as unknown as {
      canvas: { attachThreadRoot: (...args: unknown[]) => void };
    };
    const real = store.canvas.attachThreadRoot.bind(store.canvas);
    store.canvas.attachThreadRoot = () => {
      throw new Error('disk went away');
    };
    const before = entries().length;

    expect(() => harness.service.canvas.discuss(roomId, owner, documentId)).toThrow(
      'disk went away'
    );
    expect(entries()).toHaveLength(before);
    expect(storedThreadRoot()).toBeNull();

    store.canvas.attachThreadRoot = real;
    expect(harness.service.canvas.discuss(roomId, owner, documentId).created).toBe(true);
  });

  it('refuses a document this room’s table does not hold', () => {
    expect(() => harness.service.canvas.discuss(roomId, owner, 'no-such-document')).toThrow(
      expect.objectContaining({ code: 'CANVAS_DOCUMENT_NOT_FOUND' })
    );
  });

  it('refuses a stranger with the answer an unknown room gets', () => {
    const stranger = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'person:stranger',
      displayName: 'Stranger',
    }).id;
    expect(() => harness.service.canvas.discuss(roomId, stranger, documentId)).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('wakes nobody — not on the root, and not on a plain reply in it', async () => {
    const thread = harness.service.canvas.discuss(roomId, owner, documentId);
    expect(harness.runner.turns).toEqual([]);

    harness.service.post(roomId, {
      authorId: owner,
      text: 'this column looks wrong to me',
      replyTo: thread.threadRootEntryId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.runner.turns).toEqual([]);
  });

  it('narrows a thread turn’s canvas to the document it is about', async () => {
    // A second document, so "narrowed" is a claim with something to exclude.
    harness.service.canvas.open(roomId, owner, {
      type: 'json',
      data: { other: true },
      title: 'unrelated notes',
    });
    const thread = harness.service.canvas.discuss(roomId, owner, documentId);

    harness.service.post(roomId, {
      authorId: owner,
      text: '@ana what do you make of this?',
      replyTo: thread.threadRootEntryId,
    });
    await settleUntil(() => harness.runner.turns.length === 1, 'the thread turn ran');

    const canvas = harness.runner.turns[0].roomContext.canvas;
    expect(canvas?.documents.map((d) => d.title)).toEqual(['the plan']);
    // Labels only, exactly as the unnarrowed section is: no `content` field
    // reaches a prompt through this door.
    expect(Object.keys(canvas?.documents[0] ?? {}).sort()).toEqual([
      'author',
      'id',
      'lastChangedAt',
      'pinned',
      'title',
      'type',
    ]);
  });

  it('tells a turn outside the thread about the whole table', async () => {
    harness.service.canvas.open(roomId, owner, {
      type: 'json',
      data: { other: true },
      title: 'unrelated notes',
    });
    harness.service.canvas.discuss(roomId, owner, documentId);

    harness.service.post(roomId, { authorId: owner, text: '@ana how is it going?' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the channel turn ran');

    // Sorted, because two documents opened in the same millisecond tie on
    // `lastActiveAt` and the ORDER is not what this case is about.
    expect(
      harness.runner.turns[0].roomContext.canvas?.documents.map((d) => d.title).sort()
    ).toEqual(['the plan', 'unrelated notes']);
  });

  it('tells a turn in an ORDINARY thread about the whole table', async () => {
    harness.service.canvas.open(roomId, owner, {
      type: 'json',
      data: { other: true },
      title: 'unrelated notes',
    });
    harness.service.canvas.discuss(roomId, owner, documentId);
    const root = harness.service.post(roomId, { authorId: owner, text: 'a plain message' });

    harness.service.post(roomId, {
      authorId: owner,
      text: '@ana thoughts?',
      replyTo: root.id,
    });
    await settleUntil(() => harness.runner.turns.length === 1, 'the ordinary thread turn ran');

    expect(harness.runner.turns[0].roomContext.canvas?.documents).toHaveLength(2);
  });
});
