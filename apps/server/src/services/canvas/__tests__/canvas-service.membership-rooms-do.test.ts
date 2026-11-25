import {
  ANA,
  BEN,
  agents,
  jsonContent,
  markdownContent,
  applyAs,
  log,
  st,
} from './canvas-service.fixtures.js';
import { describe, it, expect } from 'vitest';
import type { UiCommand } from '@dorkos/shared/schemas';
import { RoomError } from '../../rooms/room-errors.js';
import { createRoomHarness, scriptedRunner } from '../../rooms/__tests__/room-test-harness.js';
import { canvasChangeSentence } from '../../rooms/canvas/room-canvas-service.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

describe('RoomCanvasService.apply', () => {
  describe('membership and rooms that do not exist', () => {
    it('refuses a non-member exactly as it refuses a room that is not there', () => {
      const outsider = st.authors.resolveAgent('/agents/nobody', 'Nobody').id;
      const asOutsider = (): unknown => st.canvas.open(st.room.id, outsider, jsonContent('x'));
      const asGhost = (): unknown => st.canvas.open('no-such-room', st.human, jsonContent('x'));
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
      applyAs(st.ana, 'turn-1', { action: 'open_file', sourcePath: '/work/src/router.ts' });
      applyAs(st.ana, 'turn-1', { action: 'browser_navigate', url: 'http://localhost:5173/' });
      const before = log().length;

      st.canvas.finishTurn('turn-1');

      const entries = log();
      expect(entries).toHaveLength(before + 1);
      const entry = entries.at(-1);
      expect(entry?.kind).toBe('post');
      expect(entry?.body.canvas?.ops.map((op) => op.change)).toEqual(['opened', 'opened']);
      expect(entry?.body.subjectAuthorId).toBe(st.ana);
      // It wakes nobody: no mentions, and a cascade that starts spent.
      expect(entry?.mentions).toEqual([]);
    });

    it('never throws when the entry cannot be posted, and keeps the rows', () => {
      // A room archived mid-turn is the reachable case, and it must not reject
      // out of a collector whose `closed` promise never rejects.
      applyAs(st.ana, 'turn-1', { action: 'open_canvas', content: jsonContent('one') });
      st.service.updateRoom(st.room.id, st.human, { archived: true });
      expect(() => st.canvas.finishTurn('turn-1')).not.toThrow();
      // Only the line is lost.
      expect(st.canvas.list(st.room.id)).toHaveLength(1);
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
        st.ana,
        'turn-1',
        { action: 'open_canvas', content: markdownContent('src/router.ts') },
        '/work/ana'
      );
      const id = opened.applied ? opened.documentId : '';
      const document = st.canvas.get(st.room.id, id);
      expect(document).not.toBeNull();
      expect(st.canvas.mayReadContent(document!, '/work/ana')).toBe(true);
    });

    it('withholds it from a member working somewhere else, in a room with no repo', () => {
      const opened = applyAs(
        st.ana,
        'turn-1',
        { action: 'open_canvas', content: markdownContent('src/router.ts') },
        '/work/ana'
      );
      const document = st.canvas.get(st.room.id, opened.applied ? opened.documentId : '');
      expect(st.canvas.mayReadContent(document!, '/work/ben')).toBe(false);
      // And a reader whose surface carries no directory reads as NOWHERE, never
      // as anywhere — the fail-closed direction.
      expect(st.canvas.mayReadContent(document!, undefined)).toBe(false);
    });
  });

  describe('which tree a file document came from, at home (spec `agent-home-desk` §5.6)', () => {
    /** A project room whose repo is at `/rooms/general/repo`, and Ana's copy of it. */
    function projectRoom() {
      const harness = createRoomHarness({
        agents,
        runner: scriptedRunner(() => null),
        roomRepoPath: () => '/rooms/general/repo',
      });
      const project = harness.service.createRoom(
        { kind: 'channel', title: 'Project', members: [], agentPaths: [ANA, BEN] },
        harness.human
      );
      const author = harness.authors.resolveAgent(ANA, 'Ana').id;
      const open = (
        sourcePath: string,
        kind: 'file' | 'diff' | 'markdown' = 'file',
        aheadOfMain: number | null = 2
      ) => {
        let command: UiCommand;
        if (kind === 'markdown') {
          command = { action: 'open_canvas', content: markdownContent(sourcePath) };
        } else if (kind === 'diff') {
          command = { action: 'open_diff', sourcePath };
        } else {
          command = { action: 'open_file', sourcePath };
        }
        const opened = harness.service.canvas.apply({
          roomId: project.id,
          authorId: author,
          turnId: `t-${sourcePath}`,
          command,
          // The turn stands at home and names room files by full path.
          cwd: ANA,
          worktree: '/rooms/general/worktrees/ana-1a2b3c4d',
          aheadOfMain,
        });
        return harness.service.canvas.get(project.id, opened.applied ? opened.documentId : '')!;
      };
      return { open, canvas: harness.service.canvas, roomId: project.id };
    }

    it('labels an absolute path inside the agent`s copy as its copy, with the ahead count', () => {
      const { open, canvas: projectCanvas, roomId } = projectRoom();
      const document = open('/rooms/general/worktrees/ana-1a2b3c4d/PLAN.md', 'diff');

      expect(document.treeKind).toBe('worktree');
      expect(document.aheadOfMain).toBe(2);
      expect(document.sourceLabel).toContain('2 ahead of main');
      expect(projectCanvas.resolvedTreeOf(roomId, document.id)).toBe(
        '/rooms/general/worktrees/ana-1a2b3c4d'
      );
    });
  });
});
