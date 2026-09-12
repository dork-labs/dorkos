/**
 * The session half of the one writer — everything a `session:` scope does
 * DIFFERENTLY from a room, and every difference the spec decided on purpose
 * (spec `canvas-agent-seat` §1.1, §1.2, §Data model 6).
 *
 * Runs against a real SQLite database and the real `CanvasService`, never a
 * mocked one: a mock here would encode the hypothesis rather than test it. The
 * one seam that IS injected is the channel, because a unit test has no
 * projector to publish through — and that is the same seam production injects,
 * so what is recorded here is exactly what a window would receive.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Writing `room_id` from the scope regardless of kind reddens the invariant
 *   test, and would have a session's canvas deleted by an unrelated room.
 * - Giving a session scope the room's per-turn ceiling reddens "forty land".
 * - Recomputing document ids inside `rekeyScope` reddens "the id does not
 *   move", and would hand the model ids its own tool results contradict.
 * - Sweeping a marked session while a runtime is degraded reddens the sweep
 *   test, and would delete every canvas that runtime owns.
 *
 * @module server/services/canvas/tests/session-canvas
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, canvasDocuments, eq, type Db } from '@dorkos/db';
import type { UiCommand } from '@dorkos/shared/schemas';
import { CanvasDocumentStore } from '../canvas-document-store.js';
import { CanvasService, MAX_CANVAS_DOCUMENTS, type CanvasFrame } from '../canvas-service.js';
import { roomScope, sessionScope, SESSION_AGENT_AUTHOR, SESSION_OWNER_AUTHOR } from '../scopes.js';

const SESSION = 'sess-canonical';
const SCOPE = sessionScope(SESSION);

/** A document with no natural identity, so nothing dedupes a double write away. */
const jsonContent = (label: string) => ({ type: 'json', data: { label }, title: label }) as const;

describe('CanvasService on a session scope', () => {
  let db: Db;
  let documents: CanvasDocumentStore;
  let canvas: CanvasService;
  let published: { scope: string; frame: CanvasFrame }[];
  let viewerCount: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    documents = new CanvasDocumentStore(db);
    published = [];
    viewerCount = 0;
    canvas = new CanvasService({
      documents,
      channels: {
        publish: (scope, frame) => published.push({ scope, frame }),
        viewers: () => viewerCount,
      },
    });
  });

  /** Apply one canvas command as the session's agent. */
  function applyAsAgent(command: UiCommand) {
    return canvas.apply({
      scope: SCOPE,
      authorId: SESSION_AGENT_AUTHOR,
      command,
      defaultTarget: 'active-in-view',
    });
  }

  describe('the row a session writes', () => {
    it('stores room_id NULL, so an unrelated room deletion cannot take it', () => {
      applyAsAgent({ action: 'open_canvas', content: jsonContent('notes') });
      const row = db.select().from(canvasDocuments).where(eq(canvasDocuments.scope, SCOPE)).get();
      expect(row?.roomId).toBeNull();
      expect(row?.scope).toBe(SCOPE);
    });

    it('stores room_id equal to the scope’s id for a ROOM scope — the invariant both ways', () => {
      // Asserted here rather than only in the rooms suite, because the two
      // halves of one invariant drift apart the moment they live in two files.
      // The room row has to exist: the column still carries its cascade, so an
      // invariant that wrote the wrong id would fail the foreign key here.
      seedRoom(db, 'general');
      canvas.open(roomScope('general'), 'author-ana', jsonContent('on the table'));
      const roomRow = db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.scope, roomScope('general')))
        .get();
      expect(roomRow?.roomId).toBe('general');

      applyAsAgent({ action: 'open_canvas', content: jsonContent('mine') });
      const sessionRow = db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.scope, SCOPE))
        .get();
      expect(sessionRow?.roomId).toBeNull();
    });
  });

  describe('what a session does NOT have', () => {
    it('has no per-turn ceiling: forty changes in one turn all land', () => {
      // A room caps this at `rooms.maxCanvasOpsPerTurn` because every change
      // costs the OTHER members' attention. A session's audience is one person,
      // who asked for the turn — so the LRU is the only bound it needs, which is
      // the bound it has always had.
      for (let n = 0; n < 40; n += 1) {
        const result = applyAsAgent({
          action: 'browser_navigate',
          url: `https://example.test/${n}`,
        });
        expect(result.applied, `change ${n}`).toBe(true);
      }
      expect(canvas.list(SCOPE)).toHaveLength(MAX_CANVAS_DOCUMENTS);
    });

    it('keeps no ledger and posts no line — the transcript already records the call', () => {
      // `record` is a ROOM callback and a session passes none. The proof is that
      // nothing outside the table changes: no post, and no bookkeeping to close.
      applyAsAgent({ action: 'open_canvas', content: jsonContent('one') });
      expect(published.every((p) => p.frame.type === 'canvas')).toBe(true);
      expect(published).toHaveLength(1);
    });
  });

  describe('the LRU', () => {
    it('evicts the thirteenth unpinned document and publishes a closed frame for it', () => {
      for (let n = 0; n <= MAX_CANVAS_DOCUMENTS; n += 1) {
        canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
          type: 'url',
          url: `https://example.test/${n}`,
        });
      }
      const live = canvas.list(SCOPE);
      expect(live).toHaveLength(MAX_CANVAS_DOCUMENTS);
      expect(live.some((d) => d.content.type === 'url' && d.content.url.endsWith('/0'))).toBe(
        false
      );
      expect(published.some((p) => p.frame.closed === true)).toBe(true);
    });

    /**
     * Pinned rows are EXEMPT, not counted (DOR-2006 review, finding 9/10a).
     *
     * The cap is over unpinned documents, on both sides of the wire: the window
     * counts the same set this does. When it counted all of them, thirteen
     * documents with two pinned had the window evict locally what the server
     * keeps, and the next hydrate simply put it back.
     */
    it('holds more than the cap when the extra documents are pinned', () => {
      for (let n = 0; n < MAX_CANVAS_DOCUMENTS; n += 1) {
        canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'url', url: `https://example.test/${n}` });
      }
      const pinned = [0, 1].map((n) =>
        canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
          type: 'json',
          data: { n },
          title: `pinned ${n}`,
        })
      );
      for (const document of pinned) canvas.pin(SCOPE, document.id, true);

      // Two more unpinned opens: the table is at the cap on unpinned rows, so
      // each evicts one unpinned row and neither touches a pin.
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'url',
        url: 'https://example.test/extra-1',
      });
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'url',
        url: 'https://example.test/extra-2',
      });

      const live = canvas.list(SCOPE);
      expect(live.filter((d) => !d.pinned)).toHaveLength(MAX_CANVAS_DOCUMENTS);
      expect(
        live
          .filter((d) => d.pinned)
          .map((d) => d.id)
          .sort()
      ).toEqual(pinned.map((d) => d.id).sort());
      expect(live).toHaveLength(MAX_CANVAS_DOCUMENTS + 2);
    });

    it('never evicts the document the OTHER view is showing', () => {
      // The page somebody is sitting on in Browser, opened first and never
      // touched again: `lastActiveAt` does not move when the reader switches
      // tabs, so a plain LRU takes the one document on screen the moment twelve
      // documents open in Canvas.
      const onScreen = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'url',
        url: 'https://example.test/reading-this',
      });
      for (let n = 0; n <= MAX_CANVAS_DOCUMENTS; n += 1) {
        canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
          type: 'json',
          data: { n },
          title: `doc ${n}`,
        });
      }

      expect(canvas.get(SCOPE, onScreen.id)).not.toBeNull();
      expect(canvas.list(SCOPE)).toHaveLength(MAX_CANVAS_DOCUMENTS);
    });
  });

  describe('dedupe', () => {
    it('lands two windows opening one file on ONE document', () => {
      const first = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'file',
        sourcePath: '/src/router.ts',
      });
      const second = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'file',
        sourcePath: '/src/router.ts',
      });
      expect(second.id).toBe(first.id);
      expect(canvas.list(SCOPE)).toHaveLength(1);
    });

    it('lands two json opens on TWO documents', () => {
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, jsonContent('a'));
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, jsonContent('b'));
      expect(canvas.list(SCOPE)).toHaveLength(2);
    });

    /**
     * The writer resolves the VIEWER, so an agent's `open_file` and a person's
     * land on one document (DOR-2006 review, blocker 1).
     *
     * Viewer resolution used to happen only in the client's dispatcher. Once the
     * server started writing an agent's `open_file` it wrote a bare
     * `{type:'file'}` for everything, which is two defects at once: a PNG opened
     * in a text editor ("This file isn't text and can't be shown"), and a
     * different `canvasSourceKey` from the person's `{type:'image'}` — so one
     * file grew two tabs, the exact divergence this phase exists to remove.
     */
    it('opens an agent’s chart.png as an IMAGE, and on the person’s row', () => {
      // The person opens it first, through the same content the client builds.
      const byPerson = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'image',
        src: '/assets/chart.png',
      });

      const result = applyAsAgent({ action: 'open_file', sourcePath: '/assets/chart.png' });

      expect(result.applied).toBe(true);
      expect(result.applied === true && result.documentId).toBe(byPerson.id);
      expect(canvas.list(SCOPE)).toHaveLength(1);
      expect(canvas.list(SCOPE)[0]?.content).toEqual({ type: 'image', src: '/assets/chart.png' });
    });

    it('applies this install’s viewer overrides, read per call', () => {
      // `workbench.defaultViewers` (DOR-219) lives in config the client used to
      // apply alone, so a server-side answer that ignored it disagreed with the
      // window that asked for it. Read per call, never captured: a change in
      // Settings binds the next open.
      const settings: { defaultViewers?: Record<string, string> } = {};
      const configured = new CanvasService({
        documents,
        channels: { publish: () => {}, viewers: () => 0 },
        viewerOverrides: () => settings.defaultViewers,
      });

      configured.apply({
        scope: SCOPE,
        authorId: SESSION_AGENT_AUTHOR,
        command: { action: 'open_file', sourcePath: '/assets/logo.png' },
        defaultTarget: 'active-in-view',
      });
      expect(configured.list(SCOPE)[0]?.contentType).toBe('image');

      settings.defaultViewers = { png: 'file' };
      configured.apply({
        scope: SCOPE,
        authorId: SESSION_AGENT_AUTHOR,
        command: { action: 'open_file', sourcePath: '/assets/other.png' },
        defaultTarget: 'active-in-view',
      });
      const other = configured.list(SCOPE).find((d) => d.title.includes('other'));
      expect(other?.contentType).toBe('file');
    });

    it('answers contentForCommand with the same content it would write', () => {
      // The two callers that look at the content before delegating — the room
      // flavour resolving which tree a file came from, and the claude-code
      // handler — must ask the WRITER, not the pure helper, or they see a
      // different shape for the same file than the row ends up holding.
      const configured = new CanvasService({
        documents,
        channels: { publish: () => {}, viewers: () => 0 },
        viewerOverrides: () => ({ png: 'file' }),
      });
      const peeked = configured.contentForCommand({
        action: 'open_file',
        sourcePath: '/assets/logo.png',
      });
      configured.apply({
        scope: SCOPE,
        authorId: SESSION_AGENT_AUTHOR,
        command: { action: 'open_file', sourcePath: '/assets/logo.png' },
        defaultTarget: 'active-in-view',
      });
      expect(configured.list(SCOPE)[0]?.content).toEqual(peeked);
    });
  });

  describe('the default a bare update_canvas acts on', () => {
    it('is the front document of the content’s OWN view, not the other tab’s', () => {
      // A session has one front document per view, which is what an agent's bare
      // `update_canvas` has always landed on. A room has none by design, so the
      // two scopes answer this differently on purpose.
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'markdown', content: '# doc' });
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'browser', url: 'https://example.test' });
      const result = applyAsAgent({
        action: 'update_canvas',
        content: { type: 'markdown', content: '# replaced' },
      });
      expect(result.applied).toBe(true);
      const markdown = canvas.list(SCOPE).find((d) => d.contentType === 'markdown')?.content;
      expect(markdown).toEqual({ type: 'markdown', content: '# replaced' });
      // The page is untouched: an update never rewrites the other tab.
      expect(canvas.list(SCOPE).some((d) => d.contentType === 'browser')).toBe(true);
    });

    it('refuses in a sentence when there is nothing on the canvas', () => {
      const result = applyAsAgent({
        action: 'update_canvas',
        content: { type: 'markdown', content: '# nothing to replace' },
      });
      expect(result.applied).toBe(false);
      expect(result.applied === false && result.reason).toMatch(/nothing on the canvas/i);
    });
  });

  describe('the edit lock', () => {
    it('holds the AGENT’s push while the person is typing in that document', () => {
      // The reason a session has two author ids at all. One shared id would make
      // the agent look like the lock holder and walk over the draft.
      const document = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, jsonContent('draft'));
      canvas.heartbeat(SCOPE, SESSION_OWNER_AUTHOR, document.id, true);
      const result = canvas.apply({
        scope: SCOPE,
        authorId: SESSION_AGENT_AUTHOR,
        command: {
          action: 'update_canvas',
          documentId: document.id,
          content: jsonContent('agent’s version'),
        },
        defaultTarget: 'active-in-view',
      });
      expect(result.applied).toBe(false);
      expect(result.applied === false && result.reason).toMatch(/editing that document/i);
    });
  });

  describe('viewers', () => {
    it('is the live reader count of this session’s stream, whatever the channel says', () => {
      viewerCount = 2;
      expect(canvas.viewers(SCOPE)).toBe(2);
    });
  });

  describe('rekeyScope — the trap the whole phase turns on', () => {
    it('moves every row of a scope and none of any other', () => {
      const stale = sessionScope('request-uuid');
      canvas.open(stale, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/a.ts' });
      canvas.open(stale, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/b.ts' });
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/other.ts' });

      expect(canvas.rekeyScope(stale, sessionScope('canonical-id'))).toBe(2);
      expect(canvas.list(stale)).toHaveLength(0);
      expect(canvas.list(sessionScope('canonical-id'))).toHaveLength(2);
      // The bystander scope is untouched.
      expect(canvas.list(SCOPE)).toHaveLength(1);
    });

    it('leaves the document id alone, so ids already in a tool result still resolve', () => {
      const stale = sessionScope('request-uuid');
      const opened = canvas.open(stale, SESSION_OWNER_AUTHOR, {
        type: 'file',
        sourcePath: '/src/router.ts',
      });
      canvas.rekeyScope(stale, SCOPE);
      expect(canvas.get(SCOPE, opened.id)?.id).toBe(opened.id);
    });

    it('finds the SAME row when the source is re-opened after the rekey', () => {
      // The id is a hash of the scope it was opened under, so after a rekey it
      // no longer matches what `canvasDocumentId` would compute — and that is
      // fine, because the unique index is on `(scope, source_key)`. A second row
      // here would be the bug: two tabs for one file, one of them stale.
      const stale = sessionScope('request-uuid');
      const opened = canvas.open(stale, SESSION_OWNER_AUTHOR, {
        type: 'file',
        sourcePath: '/src/router.ts',
      });
      canvas.rekeyScope(stale, SCOPE);
      const reopened = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, {
        type: 'file',
        sourcePath: '/src/router.ts',
      });
      expect(reopened.id).toBe(opened.id);
      expect(canvas.list(SCOPE)).toHaveLength(1);
    });

    it('publishes nothing: the reader re-hydrates under the new id', () => {
      const stale = sessionScope('request-uuid');
      canvas.open(stale, SESSION_OWNER_AUTHOR, jsonContent('mid-first-turn'));
      published.length = 0;
      canvas.rekeyScope(stale, SCOPE);
      expect(published).toHaveLength(0);
    });

    it('is a no-op when the old scope holds nothing — the common case', () => {
      expect(canvas.rekeyScope(sessionScope('never-used'), SCOPE)).toBe(0);
    });
  });

  describe('the orphan sweep', () => {
    /** Mark a session gone and sweep with a listing. */
    function sweep(listing: Parameters<CanvasService['sweepOrphanedCanvasDocuments']>[0]): number {
      return canvas.sweepOrphanedCanvasDocuments(listing);
    }

    beforeEach(() => {
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, jsonContent('a document'));
    });

    it('deletes the canvas of a session genuinely absent from a healthy listing', () => {
      canvas.noteSessionOrphaned(SESSION);
      expect(sweep({ sessions: [], degradedRuntimes: [] })).toBe(1);
      expect(canvas.list(SCOPE)).toHaveLength(0);
    });

    it('spares a session that came back between the mark and the sweep', () => {
      canvas.noteSessionOrphaned(SESSION);
      expect(
        sweep({ sessions: [{ id: SESSION, runtime: 'claude-code' }], degradedRuntimes: [] })
      ).toBe(0);
      expect(canvas.list(SCOPE)).toHaveLength(1);
      // And the mark is cleared: a session that is back is not pending a verdict.
      expect(canvas.orphanMarkCount()).toBe(0);
    });

    it('deletes NOTHING while any runtime degraded in that listing', () => {
      // One flaky sidecar makes every session it owns look absent. Without this,
      // the sweep would delete every canvas that runtime holds.
      canvas.noteSessionOrphaned(SESSION);
      expect(sweep({ sessions: [], degradedRuntimes: ['opencode'] })).toBe(0);
      expect(canvas.list(SCOPE)).toHaveLength(1);
      // The mark survives for a healthier pass.
      expect(canvas.orphanMarkCount()).toBe(1);
    });

    it('deletes NOTHING when the listing itself failed', () => {
      canvas.noteSessionOrphaned(SESSION);
      expect(sweep(null)).toBe(0);
      expect(canvas.list(SCOPE)).toHaveLength(1);
      expect(canvas.orphanMarkCount()).toBe(1);
    });

    it('does nothing at all when nothing is marked', () => {
      expect(sweep({ sessions: [], degradedRuntimes: [] })).toBe(0);
      expect(canvas.list(SCOPE)).toHaveLength(1);
    });
  });
});

/** Insert a room, so a `room:` canvas row has something to cascade off. */
function seedRoom(db: Db, id: string): void {
  db.$client
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, 'channel', id, `#${id}`, null, 0, '2026-09-12T10:00:00Z', '2026-09-12T10:00:00Z');
}
