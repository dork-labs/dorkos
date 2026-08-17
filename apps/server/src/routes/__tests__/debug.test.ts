/**
 * The diagnostic read surface: what it answers, and — the load-bearing half —
 * what it refuses to say.
 *
 * `/api/debug/*` is ALWAYS mounted, which it earns by carrying only what a span
 * attribute may carry: ids, counts, durations, coarse enums, ISO timestamps. The
 * leak test below poisons every reachable input with message text, an absolute
 * path, and a token, then asserts none of it survives into any response —
 * mirroring the span-poisoning test in `observability/__tests__/`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getSessionRuntimeType: vi.fn(async () => 'claude-code'),
    has: vi.fn(() => false),
    get: vi.fn(() => undefined),
    getDefault: vi.fn(() => undefined),
    getAllCapabilities: vi.fn(() => ({})),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import {
  recordDispatchStart,
  recordDispatchEnd,
  resetDispatchBuffers,
  DISPATCH_BUFFER_SIZE,
} from '../../services/observability/dispatch-buffers.js';
import { logRefusal } from '../../services/observability/refusals.js';
import {
  recordPhantomCancellation,
  resetPhantomCancellations,
} from '../../services/observability/phantom-cancellations.js';
import { runInDispatch } from '../../lib/dispatch-context.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../../services/session/session-state-projector.js';
import type { RawSessionEvent } from '../../services/session/session-state-projector.js';
import type { DebugDeps } from '../debug.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000dbb01';

/** Text, paths and credentials that must never reach a response. */
const POISON = {
  text: 'the deploy key is hunter2 and the migration is broken',
  absolutePath: '/Users/someone/secret-project/notes.md',
  token: 'sk-ant-oat01-POISONTOKEN',
};

function buildApp(deps?: DebugDeps) {
  const app = createApp();
  if (deps) app.locals.debugDeps = deps;
  finalizeApp(app);
  return app;
}

beforeEach(() => {
  resetDispatchBuffers();
  resetPhantomCancellations();
});

afterEach(() => {
  vi.restoreAllMocks();
  disposeProjector(SESSION_ID);
  resetDispatchBuffers();
  resetPhantomCancellations();
});

/**
 * Fetch a debug route, failing with the status and body when it did not answer.
 *
 * A bare `expect(res.body.x).toHaveLength(1)` against a non-200 reports
 * "Target cannot be null or undefined", which names neither the route nor what
 * came back instead — the shape that cost an hour once already.
 */
async function get(app: ReturnType<typeof buildApp>, route: string) {
  const res = await request(app).get(route);
  expect(res.status, `${route} answered ${res.status}: ${JSON.stringify(res.body)}`).toBe(200);
  return res;
}

describe('GET /api/debug/dispatches', () => {
  it('reports recent dispatches newest first', async () => {
    recordDispatchStart({ dispatchId: 'dsp_A', origin: 'room', roomId: 'room-1' });
    recordDispatchStart({ dispatchId: 'dsp_B', origin: 'session', sessionId: SESSION_ID });
    recordDispatchEnd('dsp_A', 'answered');

    const res = await get(buildApp(), '/api/debug/dispatches');
    expect(res.status).toBe(200);
    expect(res.body.recent.map((d: { dispatchId: string }) => d.dispatchId)).toEqual([
      'dsp_B',
      'dsp_A',
    ]);
    const a = res.body.recent.find((d: { dispatchId: string }) => d.dispatchId === 'dsp_A');
    expect(a).toMatchObject({ origin: 'room', roomId: 'room-1', outcome: 'answered' });
    expect(a.endedAt).not.toBeNull();
    // Still running: an outcome it does not have yet is reported as absent, not
    // guessed at.
    const b = res.body.recent.find((d: { dispatchId: string }) => d.dispatchId === 'dsp_B');
    expect(b.outcome).toBeNull();
    expect(b.endedAt).toBeNull();
  });

  it('honours ?limit and clamps it to the ring', async () => {
    for (let i = 0; i < 5; i += 1) {
      recordDispatchStart({ dispatchId: `dsp_${i}`, origin: 'task' });
    }
    const app = buildApp();
    const two = await request(app).get('/api/debug/dispatches?limit=2');
    expect(two.body.recent).toHaveLength(2);
    // Above the ring's capacity is clamped, not rejected: a 400 mid-incident
    // helps nobody, and the ring cannot produce more than it holds.
    const huge = await request(app).get('/api/debug/dispatches?limit=99999');
    expect(huge.status).toBe(200);
    expect(huge.body.recent.length).toBeLessThanOrEqual(DISPATCH_BUFFER_SIZE);
    // Junk falls back to the default rather than returning nothing.
    const junk = await request(app).get('/api/debug/dispatches?limit=banana');
    expect(junk.body.recent).toHaveLength(5);
  });

  it('answers with an empty claim list when no room service is wired', async () => {
    // Read during an incident is exactly when a subsystem is mid-crash. A 500
    // here would lose the recent-dispatch buffer along with the claims.
    const res = await get(buildApp(), '/api/debug/dispatches');
    expect(res.status).toBe(200);
    expect(res.body.claims).toEqual([]);
  });
});

describe('GET /api/debug/refusals', () => {
  it('records every refusal the logger writes, with its dispatch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runInDispatch({ dispatchId: 'dsp_R', origin: 'room', entryId: 'entry-1' }, () => {
      logRefusal('[rooms] an agent did not answer', {
        reason: 'agent_busy',
        visibility: 'damped',
        roomId: 'room-1',
        authorId: 'author-1',
      });
    });
    const res = await get(buildApp(), '/api/debug/refusals');
    expect(res.body.refusals).toHaveLength(1);
    expect(res.body.refusals[0]).toMatchObject({
      dispatchId: 'dsp_R',
      origin: 'room',
      reason: 'agent_busy',
      visibility: 'damped',
      roomId: 'room-1',
      authorId: 'author-1',
    });
  });

  it('keeps a refusal made outside any dispatch, without inventing an id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logRefusal('[relay] nothing connects this chat to an agent', {
      reason: 'no_binding',
      visibility: 'silent',
    });
    const res = await get(buildApp(), '/api/debug/refusals');
    const kept = (res.body.refusals as Array<{ reason: string; dispatchId?: string }>).find(
      (r) => r.reason === 'no_binding'
    );
    expect(kept).toBeDefined();
    expect(kept?.dispatchId).toBeUndefined();
  });
});

describe('GET /api/debug/phantom-cancellations', () => {
  it('reports the counter split by the path that produced it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordPhantomCancellation({
      sessionId: SESSION_ID,
      path: 'turn',
      phantoms: [{ toolUseId: 'toolu_1', mainThread: true, parentToolUseId: null }],
      steered: true,
    });
    recordPhantomCancellation({
      sessionId: SESSION_ID,
      path: 'pump',
      phantoms: [{ toolUseId: 'toolu_2', mainThread: false, parentToolUseId: 'toolu_task' }],
      steered: false,
    });

    const res = await get(buildApp(), '/api/debug/phantom-cancellations');
    expect(res.body).toMatchObject({
      total: 2,
      batches: 2,
      byPath: { turn: 1, pump: 1 },
      mainThread: 1,
      subagent: 1,
      steered: 1,
      sessions: 1,
    });
    expect(res.body.recent[0]).toMatchObject({ path: 'pump', toolUseIds: ['toolu_2'] });
  });

  it('answers with zeros when nothing has tripped it — the expected reading', async () => {
    const res = await get(buildApp(), '/api/debug/phantom-cancellations');
    expect(res.body.total).toBe(0);
    expect(res.body.byPath).toEqual({ turn: 0, pump: 0 });
    expect(res.body.recent).toEqual([]);
  });
});

describe('GET /api/debug/projectors and /sessions/:id', () => {
  it('lists live projectors with counts only', async () => {
    const projector = getOrCreateProjector(SESSION_ID);
    projector.ingest({ type: 'text_delta', text: POISON.text } as RawSessionEvent);

    const res = await get(buildApp(), '/api/debug/projectors');
    expect(res.status).toBe(200);
    const entry = res.body.projectors.find(
      (p: { sessionId: string }) => p.sessionId === SESSION_ID
    );
    expect(entry).toMatchObject({ seq: 1, subscribers: 0, waiters: 0, retiredIds: [] });
    expect(entry.eventLogSize).toBeGreaterThan(0);
  });

  it('names the ids a renamed session no longer answers to', async () => {
    // An incident report, a log line or a client URL may carry an id the session
    // has since retired. Without these on the surface it would appear on NO
    // projector, and "which projector owns this id?" — the 2026-07-31 question
    // this endpoint exists for — would have no answer for exactly the ids most
    // likely to be quoted (DOR-1262).
    const canonical = `${SESSION_ID}-canonical`;
    getOrCreateProjector(SESSION_ID).ingest({ type: 'turn_start' });
    rekeyProjector(SESSION_ID, canonical);

    const res = await get(buildApp(), '/api/debug/projectors');
    const entry = res.body.projectors.find((p: { sessionId: string }) => p.sessionId === canonical);
    expect(entry.retiredIds).toEqual([SESSION_ID]);
    // The retired id is not a projector of its own — one session, one entry.
    expect(
      res.body.projectors.filter((p: { sessionId: string }) => p.sessionId === SESSION_ID)
    ).toEqual([]);

    disposeProjector(canonical);
  });

  it('describes one session without any of its content', async () => {
    const projector = getOrCreateProjector(SESSION_ID);
    projector.ingest({ type: 'text_delta', text: POISON.text } as RawSessionEvent);

    const res = await get(buildApp(), `/api/debug/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    expect(res.body.projectorLive).toBe(true);
    expect(res.body.seq).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('deploy key');
  });

  it('rejects a malformed session id rather than probing with it', async () => {
    const res = await request(buildApp()).get('/api/debug/sessions/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  it('answers for a session with no live projector', async () => {
    const res = await get(buildApp(), `/api/debug/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.projectorLive).toBe(false);
    expect(res.body.lifecycle).toBeNull();
  });
});

describe('GET /api/debug/rooms/:id/bindings', () => {
  let transcriptRoot: string;

  beforeEach(() => {
    transcriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-transcripts-'));
    fs.mkdirSync(path.join(transcriptRoot, '-Users-someone-project'));
    fs.writeFileSync(path.join(transcriptRoot, '-Users-someone-project', 'has-one.jsonl'), '{}\n');
  });

  afterEach(() => {
    fs.rmSync(transcriptRoot, { recursive: true, force: true });
  });

  it('says whether a binding points at a transcript — and never says where', async () => {
    // The incident's "bindings pointing at ids with no transcript", answered
    // directly. The path is the thing this must not return.
    const app = buildApp({
      roomSessions: {
        listRoomSessions: () => [
          { roomId: 'room-1', authorId: 'ana', sessionId: 'has-one' },
          { roomId: 'room-1', authorId: 'bo', sessionId: 'has-none' },
          { roomId: 'other-room', authorId: 'cy', sessionId: 'has-one' },
        ],
      },
      transcriptProjectRoots: () => [transcriptRoot],
    });

    const res = await get(app, '/api/debug/rooms/room-1/bindings');
    expect(res.status).toBe(200);
    expect(res.body.bindings).toEqual([
      { authorId: 'ana', sessionId: 'has-one', transcriptExists: true },
      { authorId: 'bo', sessionId: 'has-none', transcriptExists: false },
    ]);
    // Both halves matter: a probe that answered `true` for everything would
    // satisfy the first row, and one that answered `false` would satisfy the
    // second.
    expect(JSON.stringify(res.body)).not.toContain(transcriptRoot);
    expect(JSON.stringify(res.body)).not.toContain('Users');
  });

  it('never probes outside the transcript roots, whatever the stored id says', async () => {
    // The id comes out of the database, so it is not attacker-controlled today
    // — but it is joined into a filesystem path, and `../../` in a stored id
    // would have this stat'ing files that are none of its business. Containment
    // is a property of the probe rather than of every writer that ever puts a
    // row in `room_sessions`.
    // Planted at exactly the path an UNCONTAINED probe would resolve to:
    // `join(<root>/<slug>, '../outside.jsonl')` is `<root>/outside.jsonl`. A
    // file somewhere merely nearby would leave this test green either way.
    const escape = path.join(transcriptRoot, 'outside.jsonl');
    fs.writeFileSync(escape, '{}\n');
    expect(
      fs.existsSync(path.join(transcriptRoot, '-Users-someone-project', '../outside.jsonl'))
    ).toBe(true);
    try {
      const app = buildApp({
        roomSessions: {
          listRoomSessions: () => [
            { roomId: 'room-1', authorId: 'ana', sessionId: '../outside' },
            { roomId: 'room-1', authorId: 'bo', sessionId: '..' },
            { roomId: 'room-1', authorId: 'cy', sessionId: '' },
            // The control: a real transcript in a real slug folder still reads
            // `true`, so this cannot pass by refusing everything.
            { roomId: 'room-1', authorId: 'di', sessionId: 'has-one' },
          ],
        },
        transcriptProjectRoots: () => [transcriptRoot],
      });
      const res = await get(app, '/api/debug/rooms/room-1/bindings');
      expect(
        res.body.bindings.map((b: { transcriptExists: boolean }) => b.transcriptExists)
      ).toEqual([false, false, false, true]);
    } finally {
      fs.rmSync(escape, { force: true });
    }
  });

  it('degrades to nothing when no room store is wired', async () => {
    const res = await get(buildApp(), '/api/debug/rooms/room-1/bindings');
    expect(res.status).toBe(200);
    expect(res.body.bindings).toEqual([]);
  });
});

describe('GET /api/debug/relay/traces/:traceId', () => {
  it('says so plainly when the relay is off, rather than 500ing', async () => {
    const res = await get(buildApp(), '/api/debug/relay/traces/dsp_X');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ spans: [], available: false });
  });

  it('returns each hop without the adapter error string', async () => {
    // `error_message` is free-form text from an adapter — it can echo the
    // payload, a URL, or a path. The response says only WHETHER there was one.
    const app = buildApp({
      relayTraceStore: {
        getTrace: () => [
          {
            id: 'row-1',
            messageId: 'msg-1',
            traceId: 'dsp_X',
            subject: 'relay.agent.claude-code.s1',
            status: 'failed',
            kind: 'delivery',
            sentAt: '2026-08-01T00:00:00.000Z',
            deliveredAt: null,
            processedAt: null,
            errorMessage: `refused: ${POISON.token} at ${POISON.absolutePath}`,
            metadata: null,
          },
        ],
      } as unknown as DebugDeps['relayTraceStore'],
    });

    const res = await get(app, '/api/debug/relay/traces/dsp_X');
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([
      {
        messageId: 'msg-1',
        subject: 'relay.agent.claude-code.s1',
        status: 'failed',
        kind: 'delivery',
        sentAt: '2026-08-01T00:00:00.000Z',
        deliveredAt: null,
        hasError: true,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(POISON.token);
    expect(JSON.stringify(res.body)).not.toContain('Users');
  });
});

describe('the whole surface leaks nothing (I7)', () => {
  it('survives a poisoned world across every route', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transcriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-poison-'));
    try {
      const projector = getOrCreateProjector(SESSION_ID, POISON.absolutePath);
      projector.ingest({ type: 'text_delta', text: POISON.text } as RawSessionEvent);
      projector.ingest({
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'Bash',
        input: `cat ${POISON.absolutePath}`,
        status: 'running',
      } as RawSessionEvent);
      runInDispatch({ dispatchId: 'dsp_P', origin: 'room' }, () => {
        // Ids stay ids — a roomId is an opaque handle and IS echoed back, by
        // design. What gets poisoned here is everything that is not an id: the
        // event payloads, the tool input, the refusal detail, the transcript
        // path, and a session id a caller could stuff a token into.
        recordDispatchStart({ dispatchId: 'dsp_P', origin: 'room', roomId: 'room-1' });
        logRefusal('[rooms] an agent did not answer', {
          reason: 'turn_failed',
          visibility: 'silent',
          sessionId: SESSION_ID,
          detail: { note: POISON.token },
        });
        // Every field of a phantom record is an id, a count or a coarse enum —
        // there is no free-form input to poison, which is the property this
        // sweep is confirming rather than an exemption from it. The id fields
        // take the token, as the room-binding case does.
        recordPhantomCancellation({
          sessionId: POISON.token,
          path: 'pump',
          phantoms: [{ toolUseId: POISON.token, mainThread: false, parentToolUseId: POISON.token }],
          steered: false,
        });
      });

      const app = buildApp({
        roomSessions: {
          listRoomSessions: () => [{ roomId: 'room-1', authorId: 'ana', sessionId: POISON.token }],
        },
        transcriptProjectRoots: () => [transcriptRoot],
      });

      const routes = [
        '/api/debug/dispatches',
        '/api/debug/refusals',
        '/api/debug/phantom-cancellations',
        '/api/debug/projectors',
        `/api/debug/sessions/${SESSION_ID}`,
        '/api/debug/rooms/room-1/bindings',
        '/api/debug/relay/traces/dsp_P',
      ];
      for (const route of routes) {
        const res = await request(app).get(route);
        expect(res.status, route).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body, route).not.toContain('deploy key');
        expect(body, route).not.toContain('hunter2');
        expect(body, route).not.toContain('notes.md');
        expect(body, route).not.toContain('/Users/');
      }
    } finally {
      fs.rmSync(transcriptRoot, { recursive: true, force: true });
    }
  });
});
