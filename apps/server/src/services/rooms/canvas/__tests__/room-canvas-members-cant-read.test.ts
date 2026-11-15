/**
 * A room canvas refuses, at open time, a file the room's members can't read
 * (DOR-4110). The check is the one the card's viewer runs, so the server and
 * the viewer cannot disagree, and the refusal names no path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { MEMBERS_CANT_READ_MESSAGE } from '@dorkos/shared/room-canvas-reading';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
} from '../../__tests__/room-test-harness.js';

const ANA = '/agents/ana';
const REPO = '/rooms/backend/repo';
const COPY = '/rooms/backend/worktrees/ana-1a2b3c4d';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** The designer's wording (#dorkos, Nov 10 11:03 CT). */
const SENTENCE =
  "Members of this room can't open files in your folder. Put the text on the canvas instead, or copy the file into the room's files first.";

describe('a room canvas and files its members cannot read (DOR-4110)', () => {
  let harness: ReturnType<typeof createRoomHarness>;
  let room: RoomWithRoster;
  let ana: string;

  function setUp(roomRepoPath: string | null) {
    harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
      roomRepoPath: () => roomRepoPath,
    });
    room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    );
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;
  }

  const apply = (
    command: Parameters<typeof harness.service.canvas.apply>[0]['command'],
    extra: { cwd?: string; worktree?: string; aheadOfMain?: number | null } = { cwd: ANA }
  ) =>
    harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId: 't1',
      command,
      ...extra,
    });

  describe('in a room with no files of its own', () => {
    beforeEach(() => setUp(null));

    it('refuses a file from the agent’s folder with the designer’s sentence, and leaves no card', () => {
      const result = apply({ action: 'open_file', sourcePath: 'notes/plan.md' });
      expect(result).toEqual({
        applied: false,
        code: 'CANVAS_MEMBERS_CANT_READ',
        reason: SENTENCE,
      });
      expect(MEMBERS_CANT_READ_MESSAGE).toBe(SENTENCE);
      expect(harness.service.canvas.list(room.id)).toEqual([]);
      expect(harness.service.canvas.ledgerFor('t1')).toEqual([]);
    });

    it('refuses an absolute path, a diff and an open_canvas file the same way', () => {
      for (const command of [
        { action: 'open_file' as const, sourcePath: `${ANA}/design/card.html` },
        { action: 'open_diff' as const, sourcePath: 'src/app.ts' },
        {
          action: 'open_canvas' as const,
          content: { type: 'file' as const, sourcePath: 'src/app.ts' },
        },
      ]) {
        expect(apply(command)).toMatchObject({ applied: false, code: 'CANVAS_MEMBERS_CANT_READ' });
      }
      expect(harness.service.canvas.list(room.id)).toEqual([]);
    });

    it('names no path and gives no hint whether the file exists', () => {
      const missing = apply({ action: 'open_file', sourcePath: 'secret/does-not-exist.md' });
      const present = apply({ action: 'open_file', sourcePath: 'notes/plan.md' });
      expect(missing).toEqual(present);
      if (missing.applied) throw new Error('expected a refusal');
      expect(missing.reason).not.toContain('secret');
      expect(missing.reason).not.toContain(ANA);
    });

    it('still opens markdown whose text travels with it, and content with no file', () => {
      expect(
        apply({
          action: 'open_canvas',
          content: { type: 'markdown', content: '# Plan', sourcePath: 'notes/plan.md' },
        })
      ).toMatchObject({ applied: true });
      expect(
        apply({ action: 'open_canvas', content: { type: 'json', data: { a: 1 }, title: 'a' } })
      ).toMatchObject({ applied: true });
    });
  });

  describe('in a room with files of its own', () => {
    beforeEach(() => setUp(REPO));

    it('opens a file in the room’s own files', () => {
      expect(apply({ action: 'open_file', sourcePath: `${REPO}/app.txt` })).toMatchObject({
        applied: true,
      });
      expect(harness.service.canvas.list(room.id)).toHaveLength(1);
    });

    it('opens a review of the agent’s copy that is ahead of the room', () => {
      expect(
        apply(
          { action: 'open_diff', sourcePath: `${COPY}/app.txt` },
          { cwd: ANA, worktree: COPY, aheadOfMain: 2 }
        )
      ).toMatchObject({ applied: true });
    });

    it('refuses a plain file in the agent’s own copy, which other members cannot open', () => {
      expect(
        apply(
          { action: 'open_file', sourcePath: `${COPY}/app.txt` },
          { cwd: ANA, worktree: COPY, aheadOfMain: 2 }
        )
      ).toMatchObject({ applied: false, code: 'CANVAS_MEMBERS_CANT_READ' });
    });

    it('refuses a diff of a copy nobody measured, which the viewer cannot review', () => {
      expect(
        apply(
          { action: 'open_diff', sourcePath: `${COPY}/app.txt` },
          { cwd: ANA, worktree: COPY, aheadOfMain: null }
        )
      ).toMatchObject({ applied: false, code: 'CANVAS_MEMBERS_CANT_READ' });
    });
  });
});
