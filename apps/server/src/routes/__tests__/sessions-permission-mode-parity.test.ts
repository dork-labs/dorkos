/**
 * @vitest-environment node
 *
 * `GET /api/sessions` and `GET /api/sessions/:id` must never disagree about a
 * session's `permissionMode` (DOR-463). That field tells a person whether their
 * agent will act without asking first, so a disagreement means one surface is
 * misreporting the safety posture of a running agent.
 *
 * The invariant, stated exactly:
 *
 *   **For every id the list presents, the detail endpoint returns the same
 *   session — same `id`, same `permissionMode`.**
 *
 * Both halves of each endpoint's answer are varied here, because a
 * `permissionMode` is TWO inputs joined: the runtime-derived value (SDK JSONL,
 * SDK threads, sidecar store — ADR-0310) and the persisted operator setting
 * (ADR-0260). An earlier version of this file returned the same runtime-derived
 * mode for every id, which pinned one input and left the endpoints free to
 * disagree through it — a test named "the two endpoints agree" that holds one of
 * the two inputs constant is not testing agreement. `runtimeMode()` below gives
 * every id a DIFFERENT runtime-derived mode, and `expectListDetailParity()`
 * sweeps every row the list returned rather than a hand-picked one.
 *
 * The registry and DB are REAL (singleton registry + in-memory SQLite),
 * mirroring sessions-list-aggregation.test.ts; only boundary/tunnel/config/
 * manifest are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { PermissionMode, Session, SessionSettings } from '@dorkos/shared/types';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();
finalizeApp(app);

/** The id DorkOS minted, which the runtime has since retired. */
const RETIRED_ID = '11111111-1111-4111-8111-111111111111';
/** The id the runtime bound for the same conversation (the SDK's own). */
const CANONICAL_ID = '22222222-2222-4222-8222-222222222222';
/** An unrelated session with no alias at all. */
const PLAIN_ID = '33333333-3333-4333-8333-333333333333';

const RUNTIME_TYPE = 'parity-fake';

/**
 * A DIFFERENT runtime-derived mode per id — the whole point. A resumed-as-new
 * session and the stale transcript it left behind carry different modes on
 * disk, which is exactly how the two endpoints could disagree even with no
 * persisted row in play.
 */
function runtimeMode(id: string): PermissionMode {
  if (id === CANONICAL_ID) return 'bypassPermissions';
  if (id === RETIRED_ID) return 'default';
  return 'acceptEdits';
}

function makeSession(id: string, permissionMode: PermissionMode = runtimeMode(id)): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode,
    runtime: RUNTIME_TYPE,
  };
}

describe('permissionMode parity between GET /api/sessions and GET /api/sessions/:id', () => {
  let db: Db;
  let runtime: FakeAgentRuntime;
  /** Settings writes the fake forwarded to the store, awaited after each PATCH. */
  let pendingWrites: Promise<void>[];

  beforeEach(() => {
    db = createTestDb();
    runtime = new FakeAgentRuntime(RUNTIME_TYPE);
    pendingWrites = [];
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtime);
    runtimeRegistry.setDefault(RUNTIME_TYPE);

    // A session is readable by whichever id it is asked about, each carrying its
    // OWN runtime-derived mode — as the transcript/thread readers behave.
    runtime.getSession.mockImplementation(async (_projectDir: string, id: string) =>
      makeSession(id)
    );
    // Write-through to the core settings store, which is what a real adapter
    // does via its injected SessionSettingsPort (ADR-0260) — runtimes never
    // touch the DB directly, and the ROUTE picks the key it is handed.
    runtime.updateSession.mockImplementation((id: string, opts: SessionSettings) => {
      pendingWrites.push(runtimeRegistry.saveSessionSettings(id, opts));
      return { updated: true };
    });
    // Default: no aliasing anywhere.
    runtime.getInternalSessionId.mockReturnValue(undefined);
    runtime.listSessions.mockResolvedValue([]);
  });

  /**
   * Bind the runtime's id alias: `RETIRED_ID` now resolves to `CANONICAL_ID`.
   * Idempotent on the canonical id, as claude-code's reverse index makes it —
   * an invariant the shared runtime-conformance suite now pins.
   */
  function withAlias(): void {
    runtime.getInternalSessionId.mockImplementation((id: string) =>
      id === RETIRED_ID || id === CANONICAL_ID ? CANONICAL_ID : undefined
    );
  }

  /**
   * THE assertion. Sweeps EVERY row the list returned and demands the detail
   * endpoint answer identically for that row's id — nothing hand-picked, so a
   * row that drifts cannot hide behind a row that does not.
   *
   * @returns The list rows, for follow-up assertions about membership.
   */
  async function expectListDetailParity(): Promise<Session[]> {
    const listRes = await request(app).get('/api/sessions');
    expect(listRes.status).toBe(200);
    const rows = listRes.body.sessions as Session[];
    expect(rows.length, 'nothing listed — the sweep would be vacuous').toBeGreaterThan(0);

    for (const row of rows) {
      const detailRes = await request(app).get(`/api/sessions/${row.id}`);
      expect(detailRes.status, `detail for listed id ${row.id}`).toBe(200);
      expect(
        detailRes.body.id,
        `list presents ${row.id} but detail answers about another session`
      ).toBe(row.id);
      expect(row.permissionMode, `list and detail disagree on permissionMode for ${row.id}`).toBe(
        detailRes.body.permissionMode
      );
    }
    return rows;
  }

  it('agrees on the runtime-derived mode when no settings are stored', async () => {
    // THE REGRESSION the review caught. With an alias in play and no stored row,
    // the list used to keep the retired row (runtime-derived 'default') while
    // `GET /:id` resolved the alias and returned the CANONICAL session
    // ('bypassPermissions'). The sidebar row said safe; the session it opened
    // was not.
    withAlias();
    runtime.listSessions.mockResolvedValue([makeSession(RETIRED_ID), makeSession(CANONICAL_ID)]);

    const rows = await expectListDetailParity();

    // The retired id is not presented at all — every id in a listing resolves to
    // itself, so there is no row that lies about which session it opens.
    expect(rows.map((r) => r.id)).toEqual([CANONICAL_ID]);
    expect(rows[0]!.permissionMode).toBe('bypassPermissions');
  });

  it('still reaches the successor when the retired transcript is the only one listed', async () => {
    // The canonical session is not in this project's listing (different cwd).
    // The retired row is still dropped rather than shown with the wrong mode.
    withAlias();
    runtime.listSessions.mockResolvedValue([makeSession(RETIRED_ID), makeSession(PLAIN_ID)]);

    const rows = await expectListDetailParity();

    expect(rows.map((r) => r.id)).toEqual([PLAIN_ID]);
    // The retired id remains reachable by id, resolving to its successor — that
    // continuity is why it must not also appear as its own row.
    const detail = await request(app).get(`/api/sessions/${RETIRED_ID}`);
    expect(detail.body.id).toBe(CANONICAL_ID);
  });

  it('agrees when the operator sets a mode on a session the runtime has aliased', async () => {
    // PATCH persists under the canonical id; both reads must find it there.
    withAlias();
    runtime.listSessions.mockResolvedValue([makeSession(CANONICAL_ID)]);

    const patch = await request(app)
      .patch(`/api/sessions/${RETIRED_ID}`)
      .send({ permissionMode: 'plan' });
    expect(patch.status).toBe(200);
    await Promise.all(pendingWrites);

    const rows = await expectListDetailParity();
    // The operator's choice wins over the runtime-derived 'bypassPermissions'.
    expect(rows[0]!.permissionMode).toBe('plan');
  });

  it('carries a row written BEFORE the alias onto the canonical id', async () => {
    // The operator sets a mode while the runtime is not tracking the session, so
    // PATCH writes under the raw id; a later turn then binds a different
    // canonical id. The adapter MOVES the row as it rebinds (DOR-493), so no
    // reader has to know the row was ever filed anywhere else.
    //
    // Claude-code-only: codex, opencode and test-mode all return `undefined`
    // unconditionally from `getInternalSessionId`, so they never alias and never
    // re-key. Here the fake stands in for the adapter — the real wiring is
    // covered by `session-settings-rekey.test.ts`.
    runtime.listSessions.mockResolvedValue([makeSession(RETIRED_ID)]);
    await request(app).patch(`/api/sessions/${RETIRED_ID}`).send({ permissionMode: 'plan' });
    await Promise.all(pendingWrites);

    // Before the alias exists the session is listed under its own id, and the
    // stored row is found under it.
    const before = await expectListDetailParity();
    expect(before[0]!.permissionMode).toBe('plan');

    // The turn binds a different canonical id, and the row goes with it.
    withAlias();
    await runtimeRegistry.rekeySessionSettings(RETIRED_ID, CANONICAL_ID);
    runtime.listSessions.mockResolvedValue([makeSession(RETIRED_ID), makeSession(CANONICAL_ID)]);

    await expectListDetailParity();
    // Both ids answer with the operator's choice, over two DIFFERENT
    // runtime-derived modes ('default' for the retired id, 'bypassPermissions'
    // for the canonical one) — so neither answer can be coming from the
    // transcript.
    const retiredRead = await request(app).get(`/api/sessions/${RETIRED_ID}`);
    expect(retiredRead.body.id).toBe(CANONICAL_ID);
    expect(retiredRead.body.permissionMode).toBe('plan');
    const canonicalRead = await request(app).get(`/api/sessions/${CANONICAL_ID}`);
    expect(canonicalRead.body.permissionMode).toBe('plan');
  });

  it('agrees with no aliasing at all (the ordinary session)', async () => {
    runtime.listSessions.mockResolvedValue([makeSession(PLAIN_ID)]);

    await request(app).patch(`/api/sessions/${PLAIN_ID}`).send({ permissionMode: 'acceptEdits' });
    await Promise.all(pendingWrites);

    const rows = await expectListDetailParity();
    expect(rows[0]!.permissionMode).toBe('acceptEdits');
  });

  it('agrees across a mixed listing of aliased and plain sessions', async () => {
    withAlias();
    runtime.listSessions.mockResolvedValue([
      makeSession(RETIRED_ID),
      makeSession(CANONICAL_ID),
      makeSession(PLAIN_ID),
    ]);
    await request(app).patch(`/api/sessions/${PLAIN_ID}`).send({ permissionMode: 'plan' });
    await Promise.all(pendingWrites);

    const rows = await expectListDetailParity();

    expect(rows.map((r) => r.id).sort()).toEqual([CANONICAL_ID, PLAIN_ID].sort());
  });

  it('agrees on model, effort, and fastMode too — one overlay, not three', async () => {
    // permissionMode is the field with a safety consequence, but it rides the
    // same overlay as the rest of the operator's settings.
    withAlias();
    runtime.listSessions.mockResolvedValue([makeSession(CANONICAL_ID)]);

    await request(app)
      .patch(`/api/sessions/${RETIRED_ID}`)
      .send({ permissionMode: 'plan', model: 'chosen-model', effort: 'high', fastMode: true });
    await Promise.all(pendingWrites);

    const listRes = await request(app).get('/api/sessions');
    const detailRes = await request(app).get(`/api/sessions/${CANONICAL_ID}`);
    const row = (listRes.body.sessions as Session[])[0]!;

    for (const field of ['permissionMode', 'model', 'effort', 'fastMode'] as const) {
      expect(row[field], `list and detail disagree on ${field}`).toBe(detailRes.body[field]);
    }
    expect(row.model).toBe('chosen-model');
  });
});
