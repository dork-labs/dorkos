/**
 * `GET /api/debug/*` — the in-memory truths, made readable without a restart.
 *
 * The 2026-07-31 incident asked five questions and the process could answer
 * none of them from outside:
 *
 * | Question                                                         | Lives in                          |
 * | ---------------------------------------------------------------- | --------------------------------- |
 * | Which agent is holding a claim, since when?                      | the dispatcher's claim map        |
 * | Is this turn parked on a person, and for how long?               | the projector's pending set       |
 * | Which projector owns this session, and who is subscribed?        | the projector registry            |
 * | Did an agent refuse, and was the refusal shown or damped?        | nothing — it was not recorded     |
 * | Does this room binding point at a session with a transcript?     | `room_sessions` vs. the disk slug |
 *
 * One more was added later, for a different reason: `phantom-cancellations` is a
 * regression tripwire rather than an incident read (DOR-1087, DOR-1288). It
 * counts how often the CLI cancels its own pending tool calls, so a class of bug
 * that was once counted by watching a session go by has a number instead.
 *
 * ## Always mounted, and why that is the safe choice
 *
 * The obvious posture is `test-control.ts`'s: mount only when an env var is set.
 * That would make this surface unavailable in exactly the situation it exists
 * for — a user's machine, mid-incident — because turning it on needs a restart,
 * and a restart destroys the in-memory state you wanted to read. So it is always
 * mounted, inheriting the app-wide `hostGuard` + `sessionGate` stack with no
 * carve-out of its own: when local login is on, this needs the operator's
 * credential exactly like `/api/sessions` does.
 *
 * It earns that by obeying the **same content discipline as the span attribute
 * allowlist**: ids, counts, durations, coarse enums, ISO timestamps. No message
 * text, no prompts, no file paths, no agent-authored strings. `transcriptExists`
 * is the sharpest case — the question is about a path, and the answer is a
 * boolean, because the path itself never crosses this boundary.
 *
 * Every handler is a `GET`. There is no mutating verb in this router and there
 * is not meant to be one.
 *
 * @module routes/debug
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import {
  recentDispatches,
  recentRefusals,
  DISPATCH_BUFFER_SIZE,
} from '../services/observability/dispatch-buffers.js';
import { phantomCancellationStats } from '../services/observability/phantom-cancellations.js';
import {
  listProjectorDebugCounters,
  peekProjector,
  getSessionEventStore,
} from '../services/session/session-state-projector.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { getRoomService } from '../services/rooms/index.js';
import type { TraceStore } from '../services/relay/trace-store.js';

/**
 * The live reads this router needs that are not reachable through a module
 * singleton, handed over once at bootstrap.
 *
 * Every part is optional and every handler degrades on its own. This surface is
 * read during an incident, which is precisely when a subsystem is most likely to
 * be missing or mid-crash, and a diagnostic endpoint that 500s then is worse
 * than no endpoint.
 */
export interface DebugDeps {
  /** Room→session bindings, for the transcript probe. */
  roomSessions?: {
    listRoomSessions(): Array<{ roomId: string; authorId: string; sessionId: string }>;
  };
  /** Absolute paths of the `projects` folders holding Claude Code transcripts. */
  transcriptProjectRoots?: () => string[];
  /** The relay's trace store, for the multi-hop trace read. */
  relayTraceStore?: TraceStore;
}

const router = Router();

/** How many buffered rows a request gets when it does not say. */
const DEFAULT_LIMIT = 50;

/**
 * Read a `?limit=` query, clamped to the ring's own capacity.
 *
 * Clamped rather than validated-and-rejected: a debug surface answering `400`
 * to `?limit=99999` helps nobody mid-incident, and the ring cannot produce more
 * than it holds anyway.
 *
 * @param raw - The raw query value.
 * @returns A limit between 1 and the buffer size.
 */
function readLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(parsed, DISPATCH_BUFFER_SIZE));
}

// GET /api/debug/dispatches — who is working right now, and what ran recently.
router.get('/dispatches', (req, res) => {
  // A room with no service wired (a bare unit-test app) reports no claims
  // rather than failing the whole response: this endpoint is read during an
  // incident, which is when a subsystem is most likely to be mid-crash.
  let claims: unknown[] = [];
  try {
    claims = getRoomService().listActiveClaims();
  } catch {
    claims = [];
  }
  res.json({ claims, recent: recentDispatches(readLimit(req.query.limit)) });
});

// GET /api/debug/refusals — every path that recently declined to do the obvious thing.
router.get('/refusals', (req, res) => {
  res.json({ refusals: recentRefusals(readLimit(req.query.limit)) });
});

// GET /api/debug/phantom-cancellations — how often the CLI cancelled its own
// pending tool calls, split by which sender saw it (DOR-1087, DOR-1288). This is
// the read spec `persistent-session-runtime` task 5.1 samples to compare the
// flag-off and flag-on legs of its measurement.
router.get('/phantom-cancellations', (req, res) => {
  res.json(phantomCancellationStats(readLimit(req.query.limit)));
});

// GET /api/debug/projectors — the live projector registry.
router.get('/projectors', (_req, res) => {
  res.json({ projectors: listProjectorDebugCounters() });
});

// GET /api/debug/sessions/:id — one session's live spine.
router.get('/sessions/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const projector = peekProjector(sessionId);
  const runtime = await runtimeRegistry.getSessionRuntimeType(sessionId).catch(() => null);
  const lock = runtimeRegistry.has(runtime ?? '')
    ? (runtimeRegistry.get(runtime as string)?.getLockInfo(sessionId) ?? null)
    : null;

  // The `'record'`-mode rows a room-driven claude-code session writes (DOR-784)
  // had NO reader until this line. Three rows a turn were being written to prove
  // a turn had run at all, and the only way to see them was to open the
  // database by hand — which is the shape of problem this whole surface exists
  // to remove. Counts and the newest boundary only; the payloads carry text.
  const store = getSessionEventStore();
  const recorded = store?.readAll(sessionId) ?? [];
  const byType: Record<string, number> = {};
  for (const event of recorded) byType[event.type] = (byType[event.type] ?? 0) + 1;

  res.json({
    sessionId,
    runtime,
    ...(projector
      ? projector.debugCounters()
      : { lifecycle: null, seq: null, subscribers: null, waiters: null }),
    projectorLive: projector !== undefined,
    lockHeldBy: lock?.clientId ?? null,
    lockAcquiredAt: lock ? new Date(lock.acquiredAt).toISOString() : null,
    pendingInteractions: (projector?.getPendingInteractions() ?? []).map((pending) => ({
      // The DTO carries the prompt itself — the tool's input, the questions.
      // Only the shape of the wait crosses this boundary.
      kind: pending.type,
      toolName: 'toolName' in pending ? pending.toolName : undefined,
      startedAt: new Date(pending.startedAt).toISOString(),
      remainingMs: pending.remainingMs,
    })),
    durableEvents: { total: recorded.length, byType },
  });
});

// GET /api/debug/rooms/:id/bindings — do this room's sessions have transcripts?
router.get('/rooms/:id/bindings', (req, res) => {
  const roomId = req.params.id;
  const deps = (req.app.locals.debugDeps ?? {}) as DebugDeps;
  const bindings = (deps.roomSessions?.listRoomSessions() ?? []).filter(
    (binding) => binding.roomId === roomId
  );
  // Every slug folder under every root, read ONCE for the whole request. Probing
  // per binding meant `roots x bindings` directory reads, and a busy room with
  // a dozen agents turned one debug read into hundreds of syscalls.
  const slugDirs = listSlugDirs(deps.transcriptProjectRoots?.() ?? []);
  res.json({
    bindings: bindings.map((binding) => ({
      authorId: binding.authorId,
      sessionId: binding.sessionId,
      // The incident's "bindings pointing at ids with no transcript", answered
      // directly. The PATH is never returned (only this boolean) — see the
      // module doc's content discipline.
      transcriptExists: transcriptExists(slugDirs, binding.sessionId),
    })),
  });
});

// GET /api/debug/relay/traces/:traceId — every hop of one dispatch across the bus.
router.get('/relay/traces/:traceId', (req, res) => {
  const traces = ((req.app.locals.debugDeps ?? {}) as DebugDeps).relayTraceStore;
  if (!traces) return res.json({ spans: [], available: false });
  const spans = traces.getTrace(req.params.traceId).map((span) => ({
    messageId: span.messageId,
    subject: span.subject,
    status: span.status,
    kind: span.kind,
    sentAt: span.sentAt,
    deliveredAt: span.deliveredAt,
    // `errorMessage` is deliberately dropped: it is a free-form string from an
    // adapter and can carry a URL, a path, or a provider's echo of the payload.
    hasError: span.errorMessage !== null,
  }));
  res.json({ spans, available: true });
});

/**
 * Every project-slug folder under every transcript root, resolved once.
 *
 * @param roots - Absolute paths of `projects` folders holding transcripts.
 * @returns Absolute paths of the slug folders inside them.
 */
function listSlugDirs(roots: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    try {
      for (const slug of fs.readdirSync(root)) dirs.push(path.join(root, slug));
    } catch {
      // An unreadable root contributes nothing rather than failing the report.
    }
  }
  return dirs;
}

/**
 * Whether a session has a transcript file in any of those folders.
 *
 * A room binding records only a session id — never the working directory the
 * session ran in — so the SDK's `projectSlug()` cannot be computed from the
 * binding, and every slug folder has to be checked for `<sessionId>.jsonl`
 * instead. Guessing a cwd to compute the slug would produce confident wrong
 * answers, which is worse than a sweep.
 *
 * **The id is contained before it reaches a path.** It comes out of the
 * database, so it is not attacker-controlled today — but it is joined into a
 * filesystem path, and a stored id of `../../etc/passwd` would have this
 * probing outside the roots entirely. `basename` costs nothing and makes the
 * containment a property of this function rather than of every writer that ever
 * puts a row in `room_sessions`.
 *
 * @param slugDirs - Absolute paths of project-slug folders, from {@link listSlugDirs}.
 * @param sessionId - The session the binding points at.
 * @returns `true` when a transcript for that id exists.
 */
function transcriptExists(slugDirs: readonly string[], sessionId: string): boolean {
  const contained = path.basename(sessionId);
  if (contained !== sessionId || contained === '' || contained === '.' || contained === '..') {
    return false;
  }
  for (const dir of slugDirs) {
    if (fs.existsSync(path.join(dir, `${contained}.jsonl`))) return true;
  }
  return false;
}

export default router;
