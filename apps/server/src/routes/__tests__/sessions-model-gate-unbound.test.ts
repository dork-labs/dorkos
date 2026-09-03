/**
 * @vitest-environment node
 *
 * The model gate, asked the two questions that decide whether it may refuse at
 * all: WHO has the standing to judge (a session NOBODY OWNS YET has no runtime,
 * only an inference) and WHETHER THE CATALOG IS EVIDENCE (a menu that marks
 * itself unverified is a guess, not authority — DOR-1688).
 *
 * ## Why this file exists rather than another `describe` in `sessions.test.ts`
 *
 * The bug this pins was unreachable in every suite the repo had, and not by
 * accident — each one is built on an assumption that erases one of the two
 * conditions it needs:
 *
 * - `sessions.test.ts` mocks the whole registry: `resolveForSession` always
 *   answers the SAME single `fakeRuntime`, and no DB is consulted. With one
 *   runtime, a model cannot belong to one while the session resolves to
 *   another; with no DB, "unbound" is not a state that exists.
 * - `runtime-registry.test.ts` does exercise the inference — but as a READ
 *   ("nothing is bricked before the binding"), which is what it was built for.
 *   Nobody asked whether a write-path REFUSAL may stand on it, because when
 *   those tests were written nothing refused anything.
 * - e2e cannot host the case at all: its server is either test-mode or the real
 *   runtimes, never both, so two runtimes with disjoint model catalogs have
 *   nowhere to disagree.
 *
 * So this file makes the case expressible: the REAL registry, a real DB, and
 * TWO runtimes with disjoint catalogs — one registered as `claude-code`, which
 * is what the registry infers for a session with no row, and one as `opencode`,
 * whose models the person is actually picking from.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

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
  configManager: { get: vi.fn(() => null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import request from 'supertest';
import type { ModelOption } from '@dorkos/shared/types';
import { createApp, finalizeApp } from '../../app.js';
import { projectModelOptions } from '../../services/runtimes/opencode/providers/models.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, eq, type Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();
finalizeApp(app);

/** No row in `session_metadata` — the state a client-minted id starts in. */
const UNBOUND = 'aaaaaaaa-0000-4000-8000-00000000000a';
/** A row naming `claude-code`, written by a first turn. */
const BOUND_CLAUDE = 'bbbbbbbb-0000-4000-8000-00000000000b';
/** A row naming `opencode`. */
const BOUND_OPENCODE = 'cccccccc-0000-4000-8000-00000000000c';

/** A model only the OpenCode catalog offers — the shape the operator picked. */
const OPENCODE_MODEL = 'openrouter/anthropic/claude-opus-4.8';
/** A model only the Claude Code catalog offers. */
const CLAUDE_MODEL = 'sonnet';

let db: Db;
let claude: FakeAgentRuntime;
let opencode: FakeAgentRuntime;

/**
 * Register two runtimes with DISJOINT model catalogs on the real singleton.
 *
 * The `claude-code` type is load-bearing: `resolveSessionRuntime` infers exactly
 * that name for a session with no row, so registering under it is what puts the
 * inference branch in front of a catalog that does not contain OpenCode's model.
 */
function registerRuntimes(): void {
  claude = new FakeAgentRuntime('claude-code');
  opencode = new FakeAgentRuntime('opencode');
  claude.getSupportedModels.mockResolvedValue([
    { value: CLAUDE_MODEL, displayName: 'Sonnet', description: '' },
  ]);
  opencode.getSupportedModels.mockResolvedValue([
    { value: OPENCODE_MODEL, displayName: 'Opus 4.8', description: '' },
  ]);
  // Both adapters write through the durable settings port, exactly as the real
  // ones do — so "the model was stored" is a fact about the row, not about a spy.
  for (const runtime of [claude, opencode]) {
    runtime.updateSession.mockImplementation((sessionId, opts) => {
      void runtimeRegistry.saveSessionSettings(sessionId, opts);
      return { updated: true };
    });
  }
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(claude);
  runtimeRegistry.register(opencode);
  runtimeRegistry.setDefault('claude-code');
}

/** Write the ownership row a first turn would have written. */
function bindSession(sessionId: string, runtime: string): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime, createdAt: new Date().toISOString() })
    .run();
}

/** The stored row for a session, or `undefined` when nothing has written one. */
function rowFor(sessionId: string) {
  return db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get();
}

/** PATCH the session's settings, as the cockpit's model picker does. */
function patch(sessionId: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/sessions/${sessionId}`).send(body);
}

describe('PATCH /api/sessions/:id — the model gate on an unbound session', () => {
  beforeEach(() => {
    // Fresh DB and fresh runtimes per test: `register` keys by type, so each
    // test overwrites the pair rather than inheriting another test's spies.
    db = createTestDb();
    registerRuntimes();
  });

  // -------------------------------------------------------------------------
  // The regression. Start a session, switch the runtime chip to OpenCode, pick
  // an OpenCode model — before sending anything. Nothing owns the session, so
  // the registry infers `claude-code`, and the gate used to refuse the person's
  // own choice in the name of a runtime they had not picked.
  // -------------------------------------------------------------------------

  it('stores a model for the runtime the person picked, on a session nothing owns yet', async () => {
    expect(rowFor(UNBOUND)).toBeUndefined();

    const res = await patch(UNBOUND, { model: OPENCODE_MODEL, runtime: 'opencode' });

    expect(res.status).toBe(200);
    expect(rowFor(UNBOUND)?.model).toBe(OPENCODE_MODEL);
  });

  it('does not bind the session it was hinted about (ADR-0255)', async () => {
    await patch(UNBOUND, { model: OPENCODE_MODEL, runtime: 'opencode' });

    // The row exists because a setting was stored in it, and it still has NO
    // owner. Ownership is the first turn's to write; a hint that could bind
    // would re-create DOR-812 through a new door.
    expect(rowFor(UNBOUND)?.runtime).toBeNull();
  });

  it('accepts the write when nobody said which runtime, rather than judging on the guess', async () => {
    // An older client, a script, the embed — none of them send the hint. The
    // honest answer is not "claude-code cannot run this": it is that nothing
    // here knows, so the turn is where this fails, with a real error.
    const res = await patch(UNBOUND, { model: OPENCODE_MODEL });

    expect(res.status).toBe(200);
    expect(rowFor(UNBOUND)?.model).toBe(OPENCODE_MODEL);
  });

  it('treats a hint naming no registered runtime as no hint at all', async () => {
    const res = await patch(UNBOUND, { model: OPENCODE_MODEL, runtime: 'not-installed' });

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // The gate keeps its teeth. DOR-1660 is a real class — a picker that offered
  // 354 models, 82 of them unrunnable — and narrowing the gate must not mean
  // deleting it.
  // -------------------------------------------------------------------------

  it('still refuses a model the hinted runtime cannot run', async () => {
    const res = await patch(UNBOUND, { model: OPENCODE_MODEL, runtime: 'claude-code' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
    expect(res.body.error).toContain('claude-code');
    expect(rowFor(UNBOUND)).toBeUndefined();
  });

  it('still refuses a model the OWNING runtime cannot run', async () => {
    bindSession(BOUND_OPENCODE, 'opencode');

    const res = await patch(BOUND_OPENCODE, { model: CLAUDE_MODEL });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
    expect(res.body.error).toContain('opencode');
  });

  it('ignores a hint that disagrees with an owner, and judges against the owner', async () => {
    bindSession(BOUND_CLAUDE, 'claude-code');

    // The one direction a hint must never buy anything: a bound session's
    // runtime is a fact, and a request does not get to argue with it.
    const res = await patch(BOUND_CLAUDE, { model: OPENCODE_MODEL, runtime: 'opencode' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('claude-code');
    expect(rowFor(BOUND_CLAUDE)?.runtime).toBe('claude-code');
  });

  it('accepts a model the owning runtime offers', async () => {
    bindSession(BOUND_CLAUDE, 'claude-code');

    const res = await patch(BOUND_CLAUDE, { model: CLAUDE_MODEL, runtime: 'opencode' });

    expect(res.status).toBe(200);
    expect(rowFor(BOUND_CLAUDE)?.model).toBe(CLAUDE_MODEL);
  });
});

// ---------------------------------------------------------------------------
// DOR-1688. The other half of the same question: even a runtime with full
// standing may only convict on evidence, and OpenCode's nothing-connected menu
// is not evidence — it is the models.dev universe cut to 200 rows, every one of
// them marked `unverified`. An operator whose credentials come from provider env
// vars can run a model that sorted past the cut, and the gate used to answer
// "the opencode runtime cannot run" it.
// ---------------------------------------------------------------------------

/**
 * A `provider.list` payload with NOTHING connected and more models than the
 * unverified menu's 200-row cap — the exact state a sidecar reports when it
 * resolved no provider credentials.
 *
 * Structural, then cast: `@opencode-ai/sdk` may not be imported outside the
 * OpenCode adapter directory (Hard Rule 2), and the projection reads only these
 * fields.
 *
 * @param count - How many models the single unconnected provider lists.
 */
function unconnectedPayload(count: number): Parameters<typeof projectModelOptions>[0] {
  const ids = Array.from({ length: count }, (_, i) => `vendor-${i}/model-${i}`);
  return {
    all: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        env: [],
        models: Object.fromEntries(
          ids.map((id, i) => [
            id,
            { id, name: `Model ${i}`, limit: { context: 128_000, output: 8_192 } },
          ])
        ),
      },
    ],
    default: {},
    connected: [],
  } as unknown as Parameters<typeof projectModelOptions>[0];
}

const UNCONNECTED_PAYLOAD = unconnectedPayload(300);

/**
 * The real capped, all-`unverified` fallback menu — produced by the projection
 * that ships, not hand-written, so the test cannot drift from what OpenCode
 * actually offers in this state.
 */
const UNVERIFIED_CATALOG = projectModelOptions(UNCONNECTED_PAYLOAD);

/**
 * A model the operator can really run that the cap cut from the menu, derived
 * from the projection rather than assumed: every id the provider listed, minus
 * every id that survived.
 */
const CUT_MODEL = Array.from({ length: 300 }, (_, i) => `openrouter/vendor-${i}/model-${i}`).find(
  (value) => !UNVERIFIED_CATALOG.some((option) => option.value === value)
)!;

/** The same rows with the guess-flag removed — a catalog that claims to be complete. */
function asVerified(options: ModelOption[]): ModelOption[] {
  return options.map((option) => {
    const copy = { ...option };
    delete copy.unverified;
    return copy;
  });
}

describe('PATCH /api/sessions/:id — the model gate on a catalog that admits it is a guess', () => {
  beforeEach(() => {
    db = createTestDb();
    registerRuntimes();
  });

  it('builds the reproduction it claims: a capped, all-unverified menu that omits a real model', () => {
    // The premise, proven rather than asserted in prose. Without these three
    // facts the test below would pass for the wrong reason.
    expect(UNVERIFIED_CATALOG).toHaveLength(200);
    expect(UNVERIFIED_CATALOG.every((option) => option.unverified)).toBe(true);
    expect(CUT_MODEL).toBeTruthy();
  });

  it('stores a model the unverified menu omits, instead of refusing on a guess', async () => {
    bindSession(BOUND_OPENCODE, 'opencode');
    opencode.getSupportedModels.mockResolvedValue(UNVERIFIED_CATALOG);

    const res = await patch(BOUND_OPENCODE, { model: CUT_MODEL });

    expect(res.status).toBe(200);
    expect(rowFor(BOUND_OPENCODE)?.model).toBe(CUT_MODEL);
  });

  it('still refuses the same model when the catalog is trustworthy', async () => {
    // The one test that keeps the gate a gate. Same rows, same missing model —
    // the ONLY difference is that this catalog does not admit to being a guess,
    // so absence from it is real evidence and the refusal must stand.
    bindSession(BOUND_OPENCODE, 'opencode');
    opencode.getSupportedModels.mockResolvedValue(asVerified(UNVERIFIED_CATALOG));

    const res = await patch(BOUND_OPENCODE, { model: CUT_MODEL });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
    expect(res.body.error).toContain('opencode');
    expect(rowFor(BOUND_OPENCODE)?.model).toBeNull();
  });

  it('declines when only SOME rows admit they are guesses', async () => {
    // Answering the ticket's open sub-question in code: the flag describes the
    // MENU ("comes from a shortened, unconfirmed menu"), so one such row means a
    // shortened menu fed this list and its absences prove nothing. It is also
    // the exact test every client surface uses to show the unverified notice.
    bindSession(BOUND_OPENCODE, 'opencode');
    opencode.getSupportedModels.mockResolvedValue([
      { value: 'openrouter/anthropic/claude-opus-4', displayName: 'Opus 4', description: '' },
      { ...UNVERIFIED_CATALOG[0] },
    ]);

    const res = await patch(BOUND_OPENCODE, { model: CUT_MODEL });

    expect(res.status).toBe(200);
    expect(rowFor(BOUND_OPENCODE)?.model).toBe(CUT_MODEL);
  });

  it('accepts a model a TRUSTWORTHY catalog lists, reaching the membership check', async () => {
    // The discriminating partner of the refusal above: same verified 200-row
    // catalog, and the ONLY thing that changes is whether the model is in it.
    // Asking this against the UNVERIFIED catalog would prove nothing — that
    // answer comes back 200 from the guess short-circuit without the membership
    // check ever running, so it would pass even if matching were deleted.
    bindSession(BOUND_OPENCODE, 'opencode');
    const verified = asVerified(UNVERIFIED_CATALOG);
    opencode.getSupportedModels.mockResolvedValue(verified);

    const res = await patch(BOUND_OPENCODE, { model: verified[0].value });

    expect(res.status).toBe(200);
    expect(rowFor(BOUND_OPENCODE)?.model).toBe(verified[0].value);
  });
});
