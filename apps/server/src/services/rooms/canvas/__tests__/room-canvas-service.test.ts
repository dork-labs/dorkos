/**
 * The one writer: everything that can say no about a room's shared canvas, and
 * the ledger the turn's single log line is composed from (spec `room-canvas`
 * §3, §5.1, §6.2).
 *
 * Everything here runs against a REAL rooms subsystem over a real SQLite
 * database (`createRoomHarness`) — never a mocked `RoomCanvasService`. A mock
 * here would encode the hypothesis rather than test it, and the properties this
 * file is about (a ceiling that can actually refuse, an entry composed from the
 * ledger rather than from what the collector saw, a reader who cannot reach a
 * tree they never could) are all properties of the real thing.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Counting the ceiling AFTER the write reddens "refuses the fourth change".
 * - Defaulting a bare `update_canvas` to the room's most recent document rather
 *   than the author's own reddens "never acts on somebody else's work".
 * - Composing the turn's entry from the applied results instead of the ledger
 *   reddens "one line per turn, naming every operation".
 * - Dropping the `lastTouchedBy` columns for a process map reddens "survives a
 *   restart" — the second service reads the same rows and finds the pointer.
 *
 * @module server/services/rooms/canvas/tests/room-canvas-service
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEntry, RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { UiCommand } from '@dorkos/shared/schemas';
import type { AuthorRegistry } from '../../author-registry.js';
import { RoomError } from '../../room-errors.js';
import type { RoomService } from '../../room-service.js';
import type { RoomCanvasService } from '../room-canvas-service.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import type { RoomBroadcaster } from '../../room-stream.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
} from '../../__tests__/room-test-harness.js';
import {
  MAX_ROOM_CANVAS_DOCUMENTS,
  NOT_IN_A_ROOM_MESSAGE,
  NO_DEFAULT_DOCUMENT_MESSAGE,
  OPEN_CANVAS_NEEDS_CONTENT_MESSAGE,
  canvasChangeSentence,
  tooManyCanvasOpsMessage,
} from '../room-canvas-service.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';

const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [BEN]: { name: 'ben', displayName: 'Ben', responseMode: 'always' },
});

/** A document with no natural identity, so nothing dedupes a double write away. */
const jsonContent = (label: string) => ({ type: 'json', data: { label }, title: label }) as const;

describe('RoomCanvasService.apply', () => {
  let service: RoomService;
  let canvas: RoomCanvasService;
  let canvasDocuments: CanvasDocumentStore;
  let broadcaster: RoomBroadcaster;
  let authors: AuthorRegistry;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let ben: string;

  beforeEach(() => {
    ({ service, authors, human, canvasDocuments, broadcaster } = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
    }));
    canvas = service.canvas;
    room = service.createRoom(
      { kind: 'channel', title: 'Release train', members: [], agentPaths: [ANA, BEN] },
      human
    );
    ana = authors.resolveAgent(ANA, 'Ana').id;
    ben = authors.resolveAgent(BEN, 'Ben').id;
  });

  /** Ask the one writer, as a room turn does. */
  const applyAs = (authorId: string, turnId: string, command: UiCommand, cwd?: string) =>
    canvas.apply({
      roomId: room.id,
      authorId,
      turnId,
      command,
      ...(cwd !== undefined ? { cwd } : {}),
    });

  /** Every entry in the room, oldest first. */
  const log = (): RoomEntry[] => service.listEntries(room.id, human, { limit: 200 });

  describe('what it refuses, and in what order', () => {
    it('refuses every window action with the room sentence, and writes nothing', () => {
      // The sixteen, expressed as everything that is NOT one of the six canvas
      // verbs — an allow-list, so a twenty-third action is refused by default
      // rather than leaking onto one agent's private stream.
      const windowActions: UiCommand[] = [
        { action: 'show_toast', message: 'hi', level: 'info' },
        { action: 'open_panel', panel: 'settings' },
        { action: 'close_panel', panel: 'settings' },
        { action: 'toggle_panel', panel: 'tasks' },
        { action: 'open_sidebar' },
        { action: 'close_sidebar' },
        { action: 'switch_sidebar_tab', tab: 'overview' },
        { action: 'set_theme', theme: 'dark' },
        { action: 'scroll_to_message' },
        { action: 'switch_agent', cwd: '/agents/ana' },
        { action: 'open_pip' },
        { action: 'close_pip' },
        { action: 'open_terminal' },
        { action: 'open_command_palette' },
        { action: 'celebrate' },
        { action: 'apply_layout', shape: 'focus' },
      ];
      expect(windowActions).toHaveLength(16);
      for (const command of windowActions) {
        const result = applyAs(ana, `turn-${command.action}`, command);
        expect(result, command.action).toEqual({
          applied: false,
          code: 'CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM',
          reason: NOT_IN_A_ROOM_MESSAGE,
        });
      }
      expect(canvas.list(room.id)).toEqual([]);
    });

    it('refuses `apply_layout` in particular — the one action that reaches the machine', () => {
      // A security property rather than a tidiness one: `apply_layout` writes
      // SKILL.md files, rewrites config and creates scheduled tasks, and a room
      // turn must not be able to reach a person's disk through the UI path.
      const result = applyAs(ana, 'turn-1', { action: 'apply_layout', shape: 'focus' });
      expect(result).toMatchObject({ applied: false, reason: NOT_IN_A_ROOM_MESSAGE });
    });

    it('refuses an `open_canvas` carrying nothing to show', () => {
      // Optional in the schema, and in a session it merely reveals the pane —
      // which a room has no equivalent of.
      const result = applyAs(ana, 'turn-1', { action: 'open_canvas' });
      expect(result).toMatchObject({
        applied: false,
        reason: OPEN_CANVAS_NEEDS_CONTENT_MESSAGE,
      });
    });

    it('refuses every write on an archived room BEFORE the table is touched', () => {
      applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('before') });
      service.updateRoom(room.id, human, { archived: true });

      const result = applyAs(ana, 'turn-2', {
        action: 'open_canvas',
        content: jsonContent('after'),
      });
      expect(result).toMatchObject({ applied: false, code: 'ROOM_ARCHIVED' });
      // And every READ still answers — the asymmetry archiving exists for.
      expect(canvas.list(room.id)).toHaveLength(1);
    });

    it('refuses a bare update from somebody with nothing of their own here', () => {
      const result = applyAs(ana, 'turn-1', {
        action: 'update_canvas',
        content: jsonContent('nothing to update'),
      });
      expect(result).toEqual({
        applied: false,
        code: 'CANVAS_NO_DEFAULT_DOCUMENT',
        reason: NO_DEFAULT_DOCUMENT_MESSAGE,
      });
      expect(canvas.list(room.id)).toEqual([]);
    });

    it('refuses a bare close from somebody with nothing of their own here', () => {
      const result = applyAs(ana, 'turn-1', { action: 'close_canvas' });
      expect(result).toMatchObject({ applied: false, code: 'CANVAS_NO_DEFAULT_DOCUMENT' });
    });
  });

  describe('the per-turn ceiling', () => {
    it('refuses the fourth change of a turn, and writes nothing for it', () => {
      // The defect this catches is the one the spec's review found: a ceiling
      // counted after the write has already answered the model successfully.
      for (const n of [1, 2, 3]) {
        expect(
          applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent(`doc ${n}`) })
            .applied,
          `open ${n}`
        ).toBe(true);
      }
      const fourth = applyAs(ana, 'turn-1', {
        action: 'open_canvas',
        content: jsonContent('doc 4'),
      });
      expect(fourth).toEqual({
        applied: false,
        code: 'TOO_MANY_CANVAS_OPS_THIS_TURN',
        reason: tooManyCanvasOpsMessage(3),
      });
      // Three rows, not four: an operation that was refused left nothing behind.
      expect(canvas.list(room.id)).toHaveLength(3);
    });

    it('survives a turn that is closed more than once', () => {
      // `finishTurn` runs from the collector's `finally`, and a room turn can
      // reach one more than once — an abort and a settle, a retry, a second
      // close on a turn that already ended. Each of those calls arrives with an
      // EMPTY ledger, so a closed record that assigned its count rather than
      // adding to it would hand the turn a fresh budget every time anything
      // closed it again. Nothing else in this file can see that: it needs a
      // second close AND an operation after it.
      for (const n of [1, 2, 3]) {
        applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent(`doc ${n}`) });
      }
      canvas.finishTurn('turn-1');
      canvas.finishTurn('turn-1');

      expect(
        applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('doc 4') })
      ).toMatchObject({ applied: false, code: 'TOO_MANY_CANVAS_OPS_THIS_TURN' });
      expect(canvas.list(room.id)).toHaveLength(3);
    });

    it('charges a late operation against the turn that spent it', () => {
      // Two ops in-turn leaves one. The straggler takes it — and is named, which
      // is the round-one behaviour — and the one after it is refused, because a
      // late operation is charged like any other rather than being free.
      for (const n of [1, 2]) {
        applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent(`doc ${n}`) });
      }
      canvas.finishTurn('turn-1');

      const third = applyAs(ana, 'turn-1', {
        action: 'open_canvas',
        content: jsonContent('doc 3'),
      });
      expect(third.applied, 'the third of three is still inside the ceiling').toBe(true);
      // A second close, with nothing open, must not give the charge back.
      canvas.finishTurn('turn-1');
      expect(
        applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('doc 4') })
      ).toMatchObject({ applied: false, code: 'TOO_MANY_CANVAS_OPS_THIS_TURN' });
      expect(canvas.list(room.id)).toHaveLength(3);
    });

    it('starts again on the next turn', () => {
      for (const n of [1, 2, 3]) {
        applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent(`a${n}`) });
      }
      expect(
        applyAs(ana, 'turn-2', { action: 'open_canvas', content: jsonContent('b1') }).applied
      ).toBe(true);
    });

    it('is read live, so moving it in Settings binds the very next operation', () => {
      // Read per call rather than captured, which is what makes a number changed
      // in Settings bind the next change instead of the next server start. A
      // captured option could only ever prove the code agrees with itself.
      let ceiling = 2;
      const live = createRoomHarness({
        agents,
        runner: scriptedRunner(() => null),
        maxCanvasOpsPerTurn: () => ceiling,
      });
      const liveRoom = live.service.createRoom(
        { kind: 'channel', title: 'Live', members: [], agentPaths: [ANA] },
        live.human
      );
      const liveAna = live.authors.resolveAgent(ANA, 'Ana').id;
      const change = (n: number) =>
        live.service.canvas.apply({
          roomId: liveRoom.id,
          authorId: liveAna,
          turnId: 'one-turn',
          command: { action: 'open_canvas', content: jsonContent(`doc ${n}`) },
        });

      expect(change(1).applied).toBe(true);
      expect(change(2).applied).toBe(true);
      expect(change(3)).toMatchObject({ reason: tooManyCanvasOpsMessage(2) });

      // Somebody raises it mid-conversation. The very next operation goes
      // through, in the SAME turn.
      ceiling = 4;
      expect(change(4).applied).toBe(true);
    });
  });

  describe('naming a document, and the default when nothing does', () => {
    it('a bare update acts on the author’s OWN last document, never another member’s', () => {
      const bensDoc = applyAs(ben, 'turn-ben', {
        action: 'open_canvas',
        content: jsonContent('Ben’s notes'),
      });
      const anasDoc = applyAs(ana, 'turn-ana', {
        action: 'open_canvas',
        content: jsonContent('Ana’s notes'),
      });
      expect(anasDoc.applied && bensDoc.applied).toBe(true);

      const updated = applyAs(ana, 'turn-ana-2', {
        action: 'update_canvas',
        content: jsonContent('Ana’s notes, revised'),
      });
      expect(updated.applied && updated.documentId).toBe(anasDoc.applied ? anasDoc.documentId : '');
      // Ben's document is exactly as he left it. This is the whole reason the
      // default is "your own last" rather than "the room's most recent".
      const bens = canvas.get(room.id, bensDoc.applied ? bensDoc.documentId : '');
      expect(bens?.title).toBe('Ben’s notes');
    });

    it('a named document is acted on even when somebody else opened it', () => {
      const bensDoc = applyAs(ben, 'turn-ben', {
        action: 'open_canvas',
        content: jsonContent('Ben’s notes'),
      });
      const id = bensDoc.applied ? bensDoc.documentId : '';
      const updated = applyAs(ana, 'turn-ana', {
        action: 'update_canvas',
        documentId: id,
        content: jsonContent('Ana edited Ben’s'),
      });
      expect(updated).toMatchObject({ applied: true, documentId: id });
      expect(canvas.get(room.id, id)?.title).toBe('Ana edited Ben’s');
    });

    it('keeps the pointer on the ROW, so a restart does not lose the default', () => {
      const opened = applyAs(ana, 'turn-1', {
        action: 'open_canvas',
        content: jsonContent('Ana’s notes'),
      });
      const id = opened.applied ? opened.documentId : '';
      // Read straight off the table rather than out of the service: what makes
      // the default survive a restart is that it is a COLUMN, and a process map
      // would pass every assertion above this one.
      expect(canvasDocuments.lastTouchedBy(room.id, ana)?.id).toBe(id);
      expect(canvasDocuments.lastTouchedBy(room.id, ben)).toBeNull();
    });
  });

  describe('dedupe, capacity and pins', () => {
    it('two agents opening the same file land on ONE document', () => {
      const first = applyAs(ana, 'turn-ana', {
        action: 'open_file',
        sourcePath: '/work/src/router.ts',
      });
      const second = applyAs(ben, 'turn-ben', {
        action: 'open_file',
        sourcePath: '/work/src/router.ts',
      });
      expect(first.applied && second.applied).toBe(true);
      expect(first.applied && second.applied && first.documentId).toBe(
        second.applied ? second.documentId : ''
      );
      expect(canvas.list(room.id)).toHaveLength(1);
    });

    it('every `json` open is a fresh document, because it has no identity', () => {
      applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('same title') });
      applyAs(ana, 'turn-2', { action: 'open_canvas', content: jsonContent('same title') });
      expect(canvas.list(room.id)).toHaveLength(2);
    });

    it('evicts the least recently active unpinned document past the ceiling', () => {
      for (let n = 0; n <= MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
        canvas.open(room.id, human, { type: 'url', url: `https://example.test/${n}` });
      }
      const live = canvas.list(room.id);
      expect(live).toHaveLength(MAX_ROOM_CANVAS_DOCUMENTS);
      // The oldest one went, and nothing else did.
      expect(live.some((d) => d.content.type === 'url' && d.content.url.endsWith('/0'))).toBe(
        false
      );
    });

    it('never evicts a pinned document, and never counts one against the ceiling', () => {
      const pinned = canvas.open(
        room.id,
        human,
        { type: 'url', url: 'https://example.test/pinned' },
        { pinned: true }
      );
      for (let n = 0; n <= MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
        canvas.open(room.id, human, { type: 'url', url: `https://example.test/${n}` });
      }
      expect(canvas.get(room.id, pinned.id)).not.toBeNull();
      expect(canvas.list(room.id)).toHaveLength(MAX_ROOM_CANVAS_DOCUMENTS + 1);
    });

    it('publishes a `closed` frame for anything it evicts', async () => {
      const frames = await collectFrames(broadcaster, room.id, async () => {
        for (let n = 0; n <= MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
          canvas.open(room.id, human, { type: 'url', url: `https://example.test/${n}` });
        }
      });
      // No viewer may be left holding a row the server dropped.
      expect(frames.filter((f) => f.type === 'canvas' && f.closed === true)).toHaveLength(1);
    });
  });

  describe('the edit lock', () => {
    it('holds an agent’s update back while somebody else is editing, and says so', () => {
      const doc = canvas.open(room.id, human, jsonContent('shared plan'));
      canvas.heartbeat(room.id, human, doc.id, true);

      const refused = applyAs(ana, 'turn-1', {
        action: 'update_canvas',
        documentId: doc.id,
        content: jsonContent('the agent’s version'),
      });
      expect(refused).toMatchObject({ applied: false, code: 'CANVAS_BEING_EDITED' });
      // Held, not lost: what the person was editing is still what is there.
      expect(canvas.get(room.id, doc.id)?.title).toBe('shared plan');
    });

    it('lapses on its own once the heartbeat is stale, with no sweeper', () => {
      // The lazy TTL is the whole design: a crashed browser stops holding a lock
      // 45 seconds later and nothing had to notice. Driven on a clock rather
      // than by waiting, so the assertion measures the rule.
      let now = Date.parse('2026-09-11T10:00:00.000Z');
      const clocked = createRoomHarness({
        agents,
        runner: scriptedRunner(() => null),
        canvasNow: () => now,
      });
      const clockedRoom = clocked.service.createRoom(
        { kind: 'channel', title: 'Clocked', members: [], agentPaths: [ANA] },
        clocked.human
      );
      const clockedAna = clocked.authors.resolveAgent(ANA, 'Ana').id;
      const doc = clocked.service.canvas.open(clockedRoom.id, clocked.human, jsonContent('plan'));
      clocked.service.canvas.heartbeat(clockedRoom.id, clocked.human, doc.id, true);

      const agentUpdate = (turnId: string) =>
        clocked.service.canvas.apply({
          roomId: clockedRoom.id,
          authorId: clockedAna,
          turnId,
          command: { action: 'update_canvas', documentId: doc.id, content: jsonContent('agent') },
        });

      // Inside the window: still held.
      now += 30_000;
      expect(agentUpdate('t1')).toMatchObject({ applied: false, code: 'CANVAS_BEING_EDITED' });

      // Past it: not a lock any more, and nothing ran to make that true.
      now += 20_000;
      expect(agentUpdate('t2')).toMatchObject({ applied: true });
    });

    it('lets the holder keep writing to their own document', () => {
      const doc = canvas.open(room.id, human, jsonContent('mine'));
      canvas.heartbeat(room.id, human, doc.id, true);
      expect(canvas.update(room.id, human, doc.id, jsonContent('mine, edited')).title).toBe(
        'mine, edited'
      );
    });

    it('refuses a second member taking a lock somebody else holds', () => {
      const doc = canvas.open(room.id, human, jsonContent('contested'));
      canvas.heartbeat(room.id, human, doc.id, true);
      expect(() => canvas.heartbeat(room.id, ben, doc.id, true)).toThrow(RoomError);
    });
  });

  describe('membership and rooms that do not exist', () => {
    it('refuses a non-member exactly as it refuses a room that is not there', () => {
      const outsider = authors.resolveAgent('/agents/nobody', 'Nobody').id;
      const asOutsider = (): unknown => canvas.open(room.id, outsider, jsonContent('x'));
      const asGhost = (): unknown => canvas.open('no-such-room', human, jsonContent('x'));
      expect(asOutsider).toThrow(RoomError);
      expect(asGhost).toThrow(RoomError);
      // Identical answers, so a room id is never a capability.
      let outsiderCode = '';
      let ghostCode = '';
      try {
        asOutsider();
      } catch (err) {
        outsiderCode = err instanceof RoomError ? err.code : '';
      }
      try {
        asGhost();
      } catch (err) {
        ghostCode = err instanceof RoomError ? err.code : '';
      }
      expect(outsiderCode).toBe(ghostCode);
    });
  });

  describe('the turn’s one line', () => {
    it('posts exactly one entry per turn, naming every operation it applied', () => {
      applyAs(ana, 'turn-1', { action: 'open_file', sourcePath: '/work/src/router.ts' });
      applyAs(ana, 'turn-1', { action: 'browser_navigate', url: 'http://localhost:5173/' });
      const before = log().length;

      canvas.finishTurn('turn-1');

      const entries = log();
      expect(entries).toHaveLength(before + 1);
      const entry = entries.at(-1);
      expect(entry?.kind).toBe('post');
      expect(entry?.body.canvas?.ops.map((op) => op.change)).toEqual(['opened', 'opened']);
      expect(entry?.body.subjectAuthorId).toBe(ana);
      // It wakes nobody: no mentions, and a cascade that starts spent.
      expect(entry?.mentions).toEqual([]);
    });

    it('writes nothing at all for a turn that applied nothing', () => {
      applyAs(ana, 'turn-1', { action: 'open_canvas' });
      const before = log().length;
      canvas.finishTurn('turn-1');
      expect(log()).toHaveLength(before);
    });

    it('clears the ledger, so a second call writes no second line', () => {
      applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('one') });
      canvas.finishTurn('turn-1');
      const after = log().length;
      canvas.finishTurn('turn-1');
      expect(log()).toHaveLength(after);
    });

    it('never throws when the entry cannot be posted, and keeps the rows', () => {
      // A room archived mid-turn is the reachable case, and it must not reject
      // out of a collector whose `closed` promise never rejects.
      applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('one') });
      service.updateRoom(room.id, human, { archived: true });
      expect(() => canvas.finishTurn('turn-1')).not.toThrow();
      // Only the line is lost.
      expect(canvas.list(room.id)).toHaveLength(1);
    });

    it('composes the sentence for a person, naming at most two and counting the rest', () => {
      expect(
        canvasChangeSentence('Ana', [
          { change: 'opened', documentId: '1', type: 'diff', title: 'src/router.ts' },
        ])
      ).toBe('Ana opened src/router.ts on the canvas.');
      expect(
        canvasChangeSentence('Ana', [
          { change: 'opened', documentId: '1', type: 'diff', title: 'src/router.ts' },
          { change: 'opened', documentId: '2', type: 'browser', title: 'localhost:5173' },
          { change: 'closed', documentId: '3', type: 'json', title: 'scratch' },
        ])
      ).toBe(
        'Ana opened src/router.ts and opened localhost:5173, and changed 1 more thing on the canvas.'
      );
    });
  });

  describe('the reader rule (§8.1)', () => {
    it('gives content to the member whose own tree the document names', () => {
      const opened = applyAs(
        ana,
        'turn-1',
        { action: 'open_file', sourcePath: 'src/router.ts' },
        '/work/ana'
      );
      const id = opened.applied ? opened.documentId : '';
      const document = canvas.get(room.id, id);
      expect(document).not.toBeNull();
      expect(canvas.mayReadContent(document!, '/work/ana')).toBe(true);
    });

    it('withholds it from a member working somewhere else, in a room with no repo', () => {
      const opened = applyAs(
        ana,
        'turn-1',
        { action: 'open_file', sourcePath: 'src/router.ts' },
        '/work/ana'
      );
      const document = canvas.get(room.id, opened.applied ? opened.documentId : '');
      expect(canvas.mayReadContent(document!, '/work/ben')).toBe(false);
      // And a reader whose surface carries no directory reads as NOWHERE, never
      // as anywhere — the fail-closed direction.
      expect(canvas.mayReadContent(document!, undefined)).toBe(false);
    });

    it('gives content to everybody for a document that names no file', () => {
      const opened = applyAs(ana, 'turn-1', {
        action: 'browser_navigate',
        url: 'http://localhost:5173/',
      });
      const document = canvas.get(room.id, opened.applied ? opened.documentId : '');
      expect(canvas.mayReadContent(document!, '/work/ben')).toBe(true);
    });

    it('gives content to every member for a document under the room’s SHARED tree', () => {
      const {
        service: shared,
        authors: sharedAuthors,
        human: owner,
      } = createRoomHarness({
        agents,
        runner: scriptedRunner(() => null),
        roomRepoPath: () => '/rooms/general/repo',
      });
      const sharedRoom = shared.createRoom(
        { kind: 'channel', title: 'Shared', members: [], agentPaths: [ANA, BEN] },
        owner
      );
      const sharedAna = sharedAuthors.resolveAgent(ANA, 'Ana').id;
      const opened = shared.canvas.apply({
        roomId: sharedRoom.id,
        authorId: sharedAna,
        turnId: 't',
        command: { action: 'open_file', sourcePath: 'src/router.ts' },
        cwd: '/rooms/general/repo',
      });
      const document = shared.canvas.get(sharedRoom.id, opened.applied ? opened.documentId : '');
      expect(shared.canvas.mayReadContent(document!, '/somewhere/else')).toBe(true);
    });
  });

  describe('the frames a change fans out', () => {
    it('publishes the whole document, not a delta', async () => {
      const frames = await collectFrames(broadcaster, room.id, async () => {
        applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('one') });
      });
      const frame = frames.find((f) => f.type === 'canvas');
      expect(frame).toBeDefined();
      expect(frame?.type === 'canvas' && frame.document?.title).toBe('one');
      expect(frame?.type === 'canvas' && frame.change).toBe('opened');
    });

    it('resyncs every live document as its own frame', () => {
      applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('one') });
      applyAs(ana, 'turn-1', { action: 'open_canvas', content: jsonContent('two') });
      const resync = canvas.resync(room.id);
      expect(resync).toHaveLength(2);
      expect(resync.every((f) => f.type === 'canvas' && f.document !== undefined)).toBe(true);
    });
  });
});

/**
 * Subscribe to a room's live stream, run `act`, and return what was fanned out.
 *
 * The real broadcaster rather than a spy on it: a `canvas` frame that never
 * reaches a subscriber is the failure this exists to catch, and a spy on
 * `publish` would report a success the stream never delivered.
 *
 * @param broadcaster - The room's live stream.
 * @param roomId - The room to listen to.
 * @param act - What to do while listening.
 * @returns Every frame delivered while `act` ran.
 */
async function collectFrames(
  broadcaster: RoomBroadcaster,
  roomId: string,
  act: () => Promise<void>
): Promise<RoomEvent[]> {
  const abort = new AbortController();
  const seen: RoomEvent[] = [];
  const reading = (async () => {
    for await (const event of broadcaster.subscribe(roomId, abort.signal)) seen.push(event);
  })();
  await act();
  // One macrotask hop for the drain loop to deliver what is queued, then stop.
  await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort();
  await reading;
  return seen;
}
