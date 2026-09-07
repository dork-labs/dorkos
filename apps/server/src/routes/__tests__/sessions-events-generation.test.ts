/**
 * The `id:` frame's GENERATION, and the rekey collision it exists to catch
 * (DOR-1704, the DOR-782 F3 residual).
 *
 * A session's `seq` belongs to a `SessionStateProjector` INSTANCE, not to the
 * session id. `rekeyProjector` can put a different instance behind the same
 * canonical id — that is what happens when a second turn resolves the same
 * canonical id while the first is already streaming — and the winner's counter
 * has nothing to do with the loser's. A reader that was on the loser comes back
 * with a number the winner finds perfectly plausible, so the epoch (same
 * process) and the range check (`cursor <= counter`) both wave it through and
 * the replay serves events that never followed the ones the reader holds.
 *
 * Every test here drives the REAL projector through the real route, and reads
 * the cursor off the wire rather than composing it, so it describes behaviour
 * rather than the frame format of the day.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectDurableEvents } from '@dorkos/test-utils';
import type { SseFrame } from '@dorkos/test-utils';
import { UNOWNED_STREAM_GENERATION } from '@dorkos/shared/session-stream';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';

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

// Declared at module scope so the vi.mock factory closure can reference it.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
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

import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createApp, finalizeApp } from '../../app.js';
import { STREAM_EPOCH } from '../../lib/stream-cursor.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  rekeyProjector,
  streamGenerationOf,
  type RawSessionEvent,
  type SessionStateProjector,
} from '../../services/session/session-state-projector.js';

const app = createApp();
finalizeApp(app);

/** The canonical id both projectors end up fighting over. */
const CANONICAL = '00000000-0000-4000-8000-0000000017a4';
/** The request id the second turn's projector is minted under first. */
const REQUEST_ID = '00000000-0000-4000-8000-0000000017b5';
/** A session used by the tests that need no collision. */
const PLAIN = '00000000-0000-4000-8000-0000000017c6';
/** Where {@link PLAIN}'s projector lives when the runtime bridges an id alias. */
const ALIASED = '00000000-0000-4000-8000-0000000017d7';

const CWD = '/mock/home';

/**
 * Point the fake runtime at the REAL projector registry, exactly as every
 * shipped runtime's `subscribeSession`/`getSessionSnapshot` do. Without this the
 * fake owns its own seq space and there is no rekey to reproduce.
 */
function bindRuntimeToProjectors(): void {
  fakeRuntime.subscribeSession = vi.fn(
    (
      ctx: SessionOpts,
      sessionId: string,
      sinceCursor?: number,
      signal?: AbortSignal
    ): AsyncIterable<SessionEvent> =>
      getOrCreateProjector(sessionId, ctx.cwd ?? CWD).subscribe(sinceCursor, signal)
  ) as unknown as typeof fakeRuntime.subscribeSession;

  fakeRuntime.getSessionSnapshot = vi.fn(
    (ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> =>
      getOrCreateProjector(sessionId, ctx.cwd ?? CWD).buildSnapshot(async () => [])
  ) as unknown as typeof fakeRuntime.getSessionSnapshot;

  // Answered off the SAME registry `subscribeSession` binds to, which is the
  // obligation the contract puts on every runtime. A fake that answered this
  // some other way would be testing a server that cannot exist.
  fakeRuntime.streamGeneration = vi.fn((_ctx: SessionOpts, sessionId: string): string =>
    streamGenerationOf(peekProjector(sessionId))
  ) as unknown as typeof fakeRuntime.streamGeneration;
}

/** Ingest `count` text deltas so the projector's counter advances. */
function feed(projector: SessionStateProjector, label: string, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    projector.ingest({ type: 'text_delta', text: `${label}${i}` } as RawSessionEvent);
  }
}

/** The `id:` line of the last frame that carried one. */
function lastFrameId(frames: SseFrame[]): string {
  const id = frames.filter((f) => f.id !== undefined).at(-1)?.id;
  if (id === undefined) throw new Error('no frame carried an id');
  return id;
}

/** The text of every `text_delta` frame, in wire order. */
function deltaTexts(frames: SseFrame[]): string[] {
  return frames
    .filter((f) => f.event === 'text_delta')
    .map((f) => (f.data as { text: string }).text);
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.hasSession.mockReturnValue(true);
  bindRuntimeToProjectors();
});

afterEach(() => {
  for (const id of [CANONICAL, REQUEST_ID, PLAIN, ALIASED]) disposeProjector(id);
});

describe('GET /api/sessions/:id/events — seq-space generation', () => {
  it('serves a snapshot, not a lying replay, when a rekey collision swapped the seq space', async () => {
    // The defect, end to end. Projector A streams five events to a reader under
    // the canonical id. A second turn's projector B — minted under a request id,
    // already carrying its own two events — then resolves the SAME canonical id,
    // so `rekeyProjector` retires A and puts B behind that id. B goes on to
    // reach seq 6.
    //
    // The reader comes back holding cursor 5. In B's counter that is a
    // completely ordinary number: same process (same epoch), same session id,
    // and 5 <= 6, so every check the server had before this one passes. The
    // replay then hands it B's seq 6 as though it followed the five events the
    // reader is actually holding, and B's own seqs 1-5 — five real events —
    // are never delivered by anything, ever. No error, no reconnect, no way for
    // the client to know. The generation is the only thing that can tell the two
    // counters apart, and the only correct answer is a fresh snapshot.
    const a = getOrCreateProjector(CANONICAL, CWD);
    feed(a, 'a', 5);

    const first = await collectDurableEvents(app, CANONICAL, {
      after: 0,
      until: (frames) => deltaTexts(frames).length >= 5,
    });
    expect(deltaTexts(first.frames)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    const staleCursor = lastFrameId(first.frames);

    const b = getOrCreateProjector(REQUEST_ID, CWD);
    feed(b, 'b', 2);
    rekeyProjector(REQUEST_ID, CANONICAL);
    feed(b, 'b', 4); // b3..b6 — B's counter is now 6, at or above the stale 5

    const second = await collectDurableEvents(app, CANONICAL, {
      lastEventId: staleCursor,
      until: (frames) => frames.length >= 1,
    });

    // A snapshot, because the cursor names a seq space that no longer serves
    // this session. Before the generation check this was a bare `text_delta`
    // carrying 'b6' and nothing else — a gap-free-looking lie.
    expect(second.frames[0]?.event).toBe('snapshot');
    expect(deltaTexts(second.frames)).toEqual([]);
    expect((second.frames[0]?.data as SessionSnapshot).cursor).toBe(6);
  });

  it('treats a cursor with no generation — an old client, a tab open across the deploy — as foreign', async () => {
    // The rollout case. A reader that connected before this shipped holds
    // `<sessionId>-<epoch>-<seq>`: same process, same session, a seq the counter
    // would happily accept. It names no seq space at all, so it can never be
    // shown to belong to the one about to answer, and it is served a snapshot
    // rather than accepted as if it matched.
    const projector = getOrCreateProjector(PLAIN, CWD);
    feed(projector, 'p', 3);

    const { frames } = await collectDurableEvents(app, PLAIN, {
      lastEventId: `${PLAIN}-${STREAM_EPOCH}-2`,
      until: (f) => f.length >= 1,
    });

    expect(frames[0]?.event).toBe('snapshot');
    expect((frames[0]?.data as SessionSnapshot).cursor).toBe(3);
  });

  it('still replays gap-free from a current-generation cursor', async () => {
    // The ordinary case has to keep working: a resume against the seq space that
    // minted the cursor replays from exactly the next event, with no snapshot.
    const projector = getOrCreateProjector(PLAIN, CWD);
    feed(projector, 'p', 3);

    const first = await collectDurableEvents(app, PLAIN, {
      after: 0,
      until: (frames) => deltaTexts(frames).length >= 3,
    });
    const cursor = lastFrameId(first.frames);

    feed(projector, 'q', 2); // seq 4 and 5

    const second = await collectDurableEvents(app, PLAIN, {
      lastEventId: cursor,
      until: (frames) => deltaTexts(frames).length >= 2,
    });

    expect(second.frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(deltaTexts(second.frames)).toEqual(['q1', 'q2']);
  });

  it('follows the SAME projector across an ordinary rekey and still resumes gap-free', async () => {
    // The other direction, and the reason the generation is per INSTANCE rather
    // than per session id. A brand-new session streams under its request id and
    // is rekeyed to its canonical id mid-turn; the reader reconnects to the
    // canonical id holding a cursor minted under the request id. The id changed
    // but the seq space did not — it is the same instance, carried across by
    // `rekeyProjector` — so this must resume, not re-hydrate.
    const projector = getOrCreateProjector(REQUEST_ID, CWD);
    feed(projector, 'r', 3);

    const first = await collectDurableEvents(app, REQUEST_ID, {
      after: 0,
      until: (frames) => deltaTexts(frames).length >= 3,
    });
    const cursor = lastFrameId(first.frames);

    rekeyProjector(REQUEST_ID, CANONICAL);
    feed(projector, 's', 2); // seq 4 and 5

    const second = await collectDurableEvents(app, CANONICAL, {
      lastEventId: cursor,
      until: (frames) => deltaTexts(frames).length >= 2,
    });

    expect(second.frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(deltaTexts(second.frames)).toEqual(['s1', 's2']);
  });

  it('stamps the generation the RUNTIME names, even when the projector lives under another id', async () => {
    // claude-code reaches a session's projector through the SDK id alias as well
    // as the registry, so the id a reader connects under may have no registry
    // entry at all while a real projector streams to it. The stream must ask the
    // runtime which counter it bound, not the registry: reading the bare id
    // answers "unowned", every frame goes out stamped `g0`, and the mismatch
    // check then accepts any cursor carrying `g0` — the guard is present and
    // protects nothing (DOR-1704).
    const alias = getOrCreateProjector(ALIASED, CWD);
    feed(alias, 'x', 2);
    // Nothing under the id the reader uses; only the runtime can bridge them.
    expect(peekProjector(PLAIN)).toBeUndefined();
    const resolveThroughAlias = (id: string): SessionStateProjector | undefined =>
      peekProjector(id) ?? peekProjector(id === PLAIN ? ALIASED : id);
    fakeRuntime.subscribeSession = vi.fn(
      (_ctx: SessionOpts, sessionId: string, since?: number, signal?: AbortSignal) =>
        resolveThroughAlias(sessionId)!.subscribe(since, signal)
    ) as unknown as typeof fakeRuntime.subscribeSession;
    fakeRuntime.streamGeneration = vi.fn((_ctx: SessionOpts, sessionId: string) =>
      streamGenerationOf(resolveThroughAlias(sessionId))
    ) as unknown as typeof fakeRuntime.streamGeneration;

    const { frames } = await collectDurableEvents(app, PLAIN, {
      after: 0,
      until: (f) => deltaTexts(f).length >= 2,
    });

    expect(alias.streamGeneration).not.toBe(UNOWNED_STREAM_GENERATION);
    expect(frames.filter((f) => f.id !== undefined).map((f) => f.id)).toEqual([
      `${PLAIN}-${STREAM_EPOCH}-${alias.streamGeneration}-1`,
      `${PLAIN}-${STREAM_EPOCH}-${alias.streamGeneration}-2`,
    ]);
  });

  it('stamps every live frame with the generation of the projector that produced it', async () => {
    // The wire half of the same fact: the id a reader echoes back has to name
    // the seq space, or the check above has nothing to compare.
    const projector = getOrCreateProjector(PLAIN, CWD);
    feed(projector, 'p', 2);

    const { frames } = await collectDurableEvents(app, PLAIN, {
      after: 0,
      until: (f) => deltaTexts(f).length >= 2,
    });

    const generation = projector.streamGeneration;
    expect(generation).toMatch(/^g[1-9]\d*$/);
    expect(frames.filter((f) => f.id !== undefined).map((f) => f.id)).toEqual([
      `${PLAIN}-${STREAM_EPOCH}-${generation}-1`,
      `${PLAIN}-${STREAM_EPOCH}-${generation}-2`,
    ]);
  });
});
