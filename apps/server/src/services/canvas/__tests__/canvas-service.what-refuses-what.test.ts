import { ANA, agents, jsonContent, applyAs, st } from './canvas-service.fixtures.js';
import { describe, it, expect } from 'vitest';
import type { UiCommand } from '@dorkos/shared/schemas';
import { RoomError } from '../../rooms/room-errors.js';
import { createRoomHarness, scriptedRunner } from '../../rooms/__tests__/room-test-harness.js';
import {
  MAX_ROOM_CANVAS_DOCUMENTS,
  NOT_IN_A_ROOM_MESSAGE,
  NO_DEFAULT_DOCUMENT_MESSAGE,
} from '../../rooms/canvas/room-canvas-service.js';
import { roomScope } from '../scopes.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

describe('RoomCanvasService.apply', () => {
  describe('what it refuses, and in what order', () => {
    it('refuses every window action with the room sentence, and writes nothing', () => {
      // The fifteen, expressed as everything that is NOT one of the six canvas
      // verbs — an allow-list, so a twenty-third action is refused by default
      // rather than leaking onto one agent's private stream.
      const windowActions: UiCommand[] = [
        { action: 'show_toast', message: 'hi', level: 'info' },
        { action: 'open_panel', panel: 'settings' },
        { action: 'close_panel', panel: 'settings' },
        { action: 'toggle_panel', panel: 'tasks' },
        { action: 'open_sidebar' },
        { action: 'close_sidebar' },
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
      expect(windowActions).toHaveLength(15);
      for (const command of windowActions) {
        const result = applyAs(st.ana, `turn-${command.action}`, command);
        expect(result, command.action).toEqual({
          applied: false,
          code: 'CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM',
          reason: NOT_IN_A_ROOM_MESSAGE,
        });
      }
      expect(st.canvas.list(st.room.id)).toEqual([]);
    });

    it('refuses `apply_layout` in particular — the one action that reaches the machine', () => {
      // A security property rather than a tidiness one: `apply_layout` writes
      // SKILL.md files, rewrites config and creates scheduled tasks, and a room
      // turn must not be able to reach a person's disk through the UI path.
      const result = applyAs(st.ana, 'turn-1', { action: 'apply_layout', shape: 'focus' });
      expect(result).toMatchObject({ applied: false, reason: NOT_IN_A_ROOM_MESSAGE });
    });

    it('refuses every write on an archived room BEFORE the table is touched', () => {
      applyAs(st.ana, 'turn-1', { action: 'open_canvas', content: jsonContent('before') });
      st.service.updateRoom(st.room.id, st.human, { archived: true });

      const result = applyAs(st.ana, 'turn-2', {
        action: 'open_canvas',
        content: jsonContent('after'),
      });
      expect(result).toMatchObject({ applied: false, code: 'ROOM_ARCHIVED' });
      // And every READ still answers — the asymmetry archiving exists for.
      expect(st.canvas.list(st.room.id)).toHaveLength(1);
    });

    it('refuses a bare update from somebody with nothing of their own here', () => {
      const result = applyAs(st.ana, 'turn-1', {
        action: 'update_canvas',
        content: jsonContent('nothing to update'),
      });
      expect(result).toEqual({
        applied: false,
        code: 'CANVAS_NO_DEFAULT_DOCUMENT',
        reason: NO_DEFAULT_DOCUMENT_MESSAGE,
      });
      expect(st.canvas.list(st.room.id)).toEqual([]);
    });
  });

  describe('no per-turn count (DOR-2739)', () => {
    it('lands a fourth, and a tenth, change in one turn', () => {
      // The retired ceiling was three. An agent changes the canvas as often as
      // a person can; the loop guards bound conversations, not operations.
      for (let n = 1; n <= 10; n += 1) {
        expect(
          applyAs(st.ana, 'turn-1', { action: 'open_canvas', content: jsonContent(`doc ${n}`) })
            .applied,
          `open ${n}`
        ).toBe(true);
      }
      expect(st.canvas.list(st.room.id)).toHaveLength(10);
    });
  });

  describe('naming a document, and the default when nothing does', () => {
    it('a bare update acts on the author’s OWN last document, never another member’s', () => {
      const bensDoc = applyAs(st.ben, 'turn-ben', {
        action: 'open_canvas',
        content: jsonContent('Ben’s notes'),
      });
      const anasDoc = applyAs(st.ana, 'turn-ana', {
        action: 'open_canvas',
        content: jsonContent('Ana’s notes'),
      });
      expect(anasDoc.applied && bensDoc.applied).toBe(true);

      const updated = applyAs(st.ana, 'turn-ana-2', {
        action: 'update_canvas',
        content: jsonContent('Ana’s notes, revised'),
      });
      expect(updated.applied && updated.documentId).toBe(anasDoc.applied ? anasDoc.documentId : '');
      // Ben's document is exactly as he left it. This is the whole reason the
      // default is "your own last" rather than "the room's most recent".
      const bens = st.canvas.get(st.room.id, bensDoc.applied ? bensDoc.documentId : '');
      expect(bens?.title).toBe('Ben’s notes');
    });

    it('a named document is acted on even when somebody else opened it', () => {
      const bensDoc = applyAs(st.ben, 'turn-ben', {
        action: 'open_canvas',
        content: jsonContent('Ben’s notes'),
      });
      const id = bensDoc.applied ? bensDoc.documentId : '';
      const updated = applyAs(st.ana, 'turn-ana', {
        action: 'update_canvas',
        documentId: id,
        content: jsonContent('Ana edited Ben’s'),
      });
      expect(updated).toMatchObject({ applied: true, documentId: id });
      expect(st.canvas.get(st.room.id, id)?.title).toBe('Ana edited Ben’s');
    });

    it('keeps the pointer on the ROW, so a restart does not lose the default', () => {
      const opened = applyAs(st.ana, 'turn-1', {
        action: 'open_canvas',
        content: jsonContent('Ana’s notes'),
      });
      const id = opened.applied ? opened.documentId : '';
      // Read straight off the table rather than out of the service: what makes
      // the default survive a restart is that it is a COLUMN, and a process map
      // would pass every assertion above this one.
      expect(st.canvasDocuments.lastTouchedBy(roomScope(st.room.id), st.ana)?.id).toBe(id);
      expect(st.canvasDocuments.lastTouchedBy(roomScope(st.room.id), st.ben)).toBeNull();
    });
  });

  describe('dedupe, capacity and pins', () => {
    it('two agents opening the same file land on ONE document', () => {
      const first = applyAs(st.ana, 'turn-ana', {
        action: 'open_file',
        sourcePath: '/work/src/router.ts',
      });
      const second = applyAs(st.ben, 'turn-ben', {
        action: 'open_file',
        sourcePath: '/work/src/router.ts',
      });
      expect(first.applied && second.applied).toBe(true);
      expect(first.applied && second.applied && first.documentId).toBe(
        second.applied ? second.documentId : ''
      );
      expect(st.canvas.list(st.room.id)).toHaveLength(1);
    });

    it('evicts the least recently active unpinned document past the ceiling', () => {
      for (let n = 0; n <= MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
        st.canvas.open(st.room.id, st.human, { type: 'url', url: `https://example.test/${n}` });
      }
      const live = st.canvas.list(st.room.id);
      expect(live).toHaveLength(MAX_ROOM_CANVAS_DOCUMENTS);
      // The oldest one went, and nothing else did.
      expect(live.some((d) => d.content.type === 'url' && d.content.url.endsWith('/0'))).toBe(
        false
      );
    });

    it('never evicts a pinned document, and never counts one against the ceiling', () => {
      const pinned = st.canvas.open(
        st.room.id,
        st.human,
        { type: 'url', url: 'https://example.test/pinned' },
        { pinned: true }
      );
      for (let n = 0; n <= MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
        st.canvas.open(st.room.id, st.human, { type: 'url', url: `https://example.test/${n}` });
      }
      expect(st.canvas.get(st.room.id, pinned.id)).not.toBeNull();
      expect(st.canvas.list(st.room.id)).toHaveLength(MAX_ROOM_CANVAS_DOCUMENTS + 1);
    });

    it('spares a pin taken on the document that was next to go', () => {
      // The discriminating case, and the one the happy path misses: fill the
      // room to its ceiling, then pin the LEAST recently active document — the
      // one eviction would reach for first — and push the room over. A carve-out
      // that only protected documents pinned at OPEN time passes the test above
      // and fails this one.
      const oldest = st.canvas.open(st.room.id, st.human, {
        type: 'url',
        url: 'https://example.test/first',
      });
      for (let n = 1; n < MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
        st.canvas.open(st.room.id, st.human, { type: 'url', url: `https://example.test/${n}` });
      }
      expect(st.canvas.list(st.room.id)).toHaveLength(MAX_ROOM_CANVAS_DOCUMENTS);

      // Pinning takes it out of the count, so it takes TWO more opens to put the
      // room back over — which is itself the second half of the carve-out.
      st.canvas.pin(st.room.id, st.human, oldest.id, true);
      st.canvas.open(st.room.id, st.human, { type: 'url', url: 'https://example.test/newer' });
      st.canvas.open(st.room.id, st.human, { type: 'url', url: 'https://example.test/newest' });

      expect(st.canvas.get(st.room.id, oldest.id)).not.toBeNull();
      // …and somebody else went instead, so the ceiling still bites.
      const live = st.canvas.list(st.room.id);
      expect(live).toHaveLength(MAX_ROOM_CANVAS_DOCUMENTS + 1);
      expect(live.some((d) => d.content.type === 'url' && d.content.url.endsWith('/1'))).toBe(
        false
      );
    });
  });

  describe('the edit lock', () => {
    it('holds an agent’s update back while somebody else is editing, and says so', () => {
      const doc = st.canvas.open(st.room.id, st.human, jsonContent('shared plan'));
      st.canvas.heartbeat(st.room.id, st.human, doc.id, true);

      const refused = applyAs(st.ana, 'turn-1', {
        action: 'update_canvas',
        documentId: doc.id,
        content: jsonContent('the agent’s version'),
      });
      expect(refused).toMatchObject({ applied: false, code: 'CANVAS_BEING_EDITED' });
      // Held, not lost: what the person was editing is still what is there.
      expect(st.canvas.get(st.room.id, doc.id)?.title).toBe('shared plan');
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

    it('refuses a second member taking a lock somebody else holds', () => {
      const doc = st.canvas.open(st.room.id, st.human, jsonContent('contested'));
      st.canvas.heartbeat(st.room.id, st.human, doc.id, true);
      expect(() => st.canvas.heartbeat(st.room.id, st.ben, doc.id, true)).toThrow(RoomError);
    });
  });
});
