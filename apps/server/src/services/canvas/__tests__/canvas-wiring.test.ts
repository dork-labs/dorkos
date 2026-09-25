/**
 * How the canvas domain is wired into the server process (spec
 * `canvas-agent-seat` §1.2, §1.6; DOR-2006 review findings 3 and 4).
 *
 * Both are properties of the composition root rather than of any one method, so
 * neither is visible to the writer's own suite:
 *
 * - **Who registers the writer.** The room subsystem registers the canvas
 *   service it hands back, so server routes and tools share one writer.
 * - **What a rekey listener may do to the rename.** The projector fans rekeys
 *   out with no guard of its own, so a throw here aborts every listener after
 *   it — the connector attach set, the room bindings — and propagates into the
 *   trigger, mid-first-turn.
 *
 * Real SQLite and the real projector throughout: both facts are about what
 * happens when a real database says no.
 *
 * @module server/services/canvas/tests/canvas-wiring
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { createRoomSubsystem } from '../../rooms/index.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../../session/session-state-projector.js';
import { CanvasDocumentStore } from '../canvas-document-store.js';
import { CanvasService } from '../canvas-service.js';
import { peekCanvasService, setCanvasService } from '../index.js';
import { sessionScope, SESSION_OWNER_AUTHOR } from '../scopes.js';

/** The placeholder id a brand-new session is created under. */
const PLACEHOLDER = '00dfdce7-1111-4222-8333-444444444444';
/** The id the runtime renames it to, mid-first-turn. */
const CANONICAL = '0e7270c6-5555-4666-8777-888888888888';

/** A migrated in-memory database. */
function freshDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

/** A canvas service over `db`, with the channel stubbed (a unit has no projector). */
function serviceOver(db: Db): CanvasService {
  return new CanvasService({
    documents: new CanvasDocumentStore(db),
    channels: { publish: () => {}, viewers: () => 0 },
  });
}

describe('canvas writer registration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the same instance it returns', () => {
    const subsystem = createRoomSubsystem({ db: freshDb() });

    expect(peekCanvasService()).toBe(subsystem.canvas);
  });
});

describe('the rekey listener', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    disposeProjector(PLACEHOLDER);
    disposeProjector(CANONICAL);
  });

  it('carries a canvas across the rename', () => {
    const db = freshDb();
    const canvas = serviceOver(db);
    setCanvasService(canvas);
    canvas.open(sessionScope(PLACEHOLDER), SESSION_OWNER_AUTHOR, {
      type: 'file',
      sourcePath: '/src/router.ts',
    });
    // A real projector under the placeholder is what `rekeyProjector` moves —
    // the listener only fires for a rename that actually happened.
    getOrCreateProjector(PLACEHOLDER, '/agents/ana');

    rekeyProjector(PLACEHOLDER, CANONICAL);

    expect(canvas.list(sessionScope(PLACEHOLDER))).toHaveLength(0);
    expect(canvas.list(sessionScope(CANONICAL))).toHaveLength(1);
  });

  it('survives a writer that throws, so one canvas cannot break the rename', () => {
    // Throwable for real: renaming into a scope that already holds the same
    // source key fails the `(scope, source_key)` unique index. A throw here
    // would abort every listener after this one and propagate into the trigger.
    const db = freshDb();
    const canvas = serviceOver(db);
    vi.spyOn(canvas, 'rekeyScope').mockImplementation(() => {
      throw new Error(
        'UNIQUE constraint failed: canvas_documents.scope, canvas_documents.source_key'
      );
    });
    setCanvasService(canvas);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    getOrCreateProjector(PLACEHOLDER, '/agents/ana');

    expect(() => rekeyProjector(PLACEHOLDER, CANONICAL)).not.toThrow();

    // And it says so, with both ids, rather than swallowing it.
    const said = warn.mock.calls.find(([message]) => String(message).includes('[canvas]'));
    expect(said).toBeDefined();
    expect(said?.[1]).toMatchObject({ oldSessionId: PLACEHOLDER, newSessionId: CANONICAL });
  });
});
