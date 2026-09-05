/**
 * `GET /api/debug/*` — the in-memory truths, made readable without a restart.
 *
 * The 2026-07-31 incident asked five questions and the process could answer
 * none of them from outside:
 *
 * | Question                                                         | Lives in                            |
 * | ---------------------------------------------------------------- | ----------------------------------- |
 * | Which agent is holding a claim, since when?                      | the dispatcher's claim map          |
 * | Is this turn parked on a person, and for how long?               | the projector's pending set         |
 * | Which projector owns this session, and who is subscribed?        | the projector registry              |
 * | Did an agent refuse, and was the refusal shown or damped?        | nothing — it was not recorded       |
 * | Does this room binding still have its conversation?              | the shared probe, `room_sessions`   |
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
 * text, no prompts, no file paths, no agent-authored strings. The room-binding
 * transcript read is the sharpest case — the question is about a path, and the
 * answer is an enum, because neither the transcript path nor the agent
 * directory the probe resolved ever crosses this boundary.
 *
 * ## Raw state, but never a raw answer that contradicts the doctor
 *
 * This bag hands over raw state; `GET /api/health/deep` answers questions. Where
 * both look at the same thing they must not silently say different things about
 * it, and for room bindings they did: this router ran its own any-slug sweep,
 * which finds a stale-slug transcript no resume could ever reach, and reported
 * it as `transcriptExists: true` while the doctor warned about the same binding
 * (DOR-1780). The canonical verdict now comes from the one shared probe both the
 * doctor and the boot sweep read (DOR-805). The raw sweep is still reported
 * beside it — it is the incident read, and cheap — but it is named for what it
 * is and any difference between the two is labelled in the response itself.
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
import {
  probeRoomBindingTranscript,
  type RoomBindingTranscriptAnswer,
  type RoomBindingTranscriptDeps,
} from '../services/rooms/session-bindings/room-binding-transcripts.js';
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
  /**
   * The canonical "does this binding still have its conversation" probe — the
   * SAME object the boot-time convergence sweep and `dorkos doctor --deep` are
   * handed (DOR-805).
   *
   * Undefined when this process has no claude-code runtime, because the probe
   * IS that runtime's transcript reader. The response then says
   * `canonical: 'unavailable'` per binding rather than quietly promoting the raw
   * sweep to the answer.
   */
  roomBindingTranscripts?: RoomBindingTranscriptDeps;
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
  // Beside the claims, because the pair is the question: who is working, and who
  // is waiting on somebody who is. A room with neither a claim nor an answer is
  // otherwise indistinguishable from a room whose message was lost.
  let holds: unknown[] = [];
  try {
    const rooms = getRoomService();
    claims = rooms.listActiveClaims();
    holds = rooms.listHolds();
  } catch {
    // No room service wired, or it is mid-crash. Whatever was gathered before
    // the throw is kept and reported — so if `listActiveClaims()` returned and
    // `listHolds()` threw, you get the real claims beside an empty `holds`,
    // rather than both blanked (which is what the earlier `claims = []; holds =
    // []` here did). That is deliberate for this endpoint: it is read during an
    // incident, and half an answer beats none. It does mean an empty array is
    // "nothing to report" and "could not be read" at once — acceptable for a
    // debug view, and the reason nothing else should copy this shape.
  }
  res.json({ claims, holds, recent: recentDispatches(readLimit(req.query.limit)) });
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
  // `resolveSessionRuntime`, not `getSessionRuntimeType`, for the second half it
  // returns: an id nothing has bound resolves through the registry's legacy
  // inference to `claude-code`, and a room placeholder is exactly such an id
  // (DOR-1780). Reporting the guess as the runtime made this surface state as
  // fact something no other surface would agree with. `bound: false` says the
  // type is what this session WOULD get, not what it has.
  const resolution = await runtimeRegistry
    .resolveSessionRuntime(sessionId)
    .catch(() => null as { type: string; bound: boolean } | null);
  const runtime = resolution?.type ?? null;
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
    // `false` when `runtime` above is the registry's inference rather than a
    // recorded owner; `null` when the read itself failed.
    runtimeBound: resolution?.bound ?? null,
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

// GET /api/debug/rooms/:id/bindings — do this room's sessions still have their
// conversations? Two answers, and the response says when they differ.
router.get('/rooms/:id/bindings', async (req, res) => {
  const roomId = req.params.id;
  const deps = (req.app.locals.debugDeps ?? {}) as DebugDeps;
  const bindings = (deps.roomSessions?.listRoomSessions() ?? []).filter(
    (binding) => binding.roomId === roomId
  );
  // Every slug folder under every root, read ONCE for the whole request. Probing
  // per binding meant `roots x bindings` directory reads, and a busy room with
  // a dozen agents turned one debug read into hundreds of syscalls.
  const slugDirs = listSlugDirs(deps.transcriptProjectRoots?.() ?? []);
  const probe = deps.roomBindingTranscripts;

  // Sequential for the reason the shared survey is: this walks a disk on behalf
  // of a report somebody is reading mid-incident, and a burst of parallel reads
  // on a room with a dozen agents buys nothing worth the load.
  const rows: Array<{
    authorId: string;
    sessionId: string;
    canonical: CanonicalVerdict;
    anySlugSweepFound: boolean;
    divergence: BindingDivergence;
  }> = [];
  for (const binding of bindings) {
    // The raw incident read: is there a file named for this session id under
    // ANY project slug? Kept because it is the question a person poking at a
    // broken install actually types, and because it is the half that catches a
    // transcript that exists somewhere the canonical probe will not look.
    const anySlugSweepFound = transcriptExists(slugDirs, binding.sessionId);
    // The canonical read: the same probe, on the same object, that the doctor
    // and the boot sweep ask (DOR-805). Neither the verdict's `agentPath` nor
    // its `error` is returned — both are free-form and this surface is not.
    const canonical: CanonicalVerdict = probe
      ? (await probeRoomBindingTranscript(binding, probe)).verdict
      : 'unavailable';
    rows.push({
      authorId: binding.authorId,
      sessionId: binding.sessionId,
      canonical,
      anySlugSweepFound,
      divergence: divergenceOf(canonical, anySlugSweepFound),
    });
  }
  res.json({ bindings: rows });
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
 * The canonical verdict as it crosses this boundary: the shared probe's own
 * verdict, plus `'unavailable'` for the process that has no probe to ask.
 *
 * `'unavailable'` is a fifth value rather than a `null` because it is a
 * different fact from every other one: not "this binding is fine", not "nothing
 * could be read about it", but "the canonical question was never asked here".
 */
type CanonicalVerdict = RoomBindingTranscriptAnswer['verdict'] | 'unavailable';

/**
 * Why the two answers about one binding pull in different directions, or `null`
 * when nothing about the pair needs explaining.
 *
 * This field is the whole point of returning both (DOR-1780). A reader who sees
 * the raw sweep say `true` and the doctor warn about the same binding must be
 * able to learn WHY from the response itself, rather than concluding one of the
 * two is broken.
 *
 * **`null` is not symmetric, on purpose.** It means "reading these two together
 * misleads nobody", not "the two answers are equal" — which they cannot be,
 * since one is a boolean and the other has five values. A `not-applicable`
 * canonical beside a sweep that found NOTHING is `null`: the probe declined the
 * question and there is no file to be misread as an answer to it. The same
 * `not-applicable` beside a sweep that found something is
 * `runtime-keeps-no-transcript`, because now there IS a `true` on the response
 * that a reader could take for a verdict.
 *
 * - `stale-slug` — a transcript with this id is on disk under some other
 *   project's slug, but not under the slug of the directory this agent is in
 *   now, so a resume finds nothing. This is the divergence the ticket was
 *   filed for: the sweep's `true` is real and useless.
 * - `runtime-keeps-no-transcript` — the sweep found a file, but this binding is
 *   not a claude-code binding (or its author is not an agent this install
 *   knows), so the canonical probe has no opinion and the file it found belongs
 *   to a different question.
 * - `canonical-unreadable` — the agent lookup, the runtime read or the
 *   transcript read failed, so nothing is known either way and the sweep's
 *   boolean is not a stand-in for it.
 * - `canonical-unavailable` — this process has no claude-code runtime, so there
 *   is no canonical probe to compare against at all.
 * - `sweep-blind` — the canonical probe found the conversation and the sweep did
 *   not, which means the sweep's roots do not cover where the probe looked.
 */
type BindingDivergence =
  | null
  | 'stale-slug'
  | 'runtime-keeps-no-transcript'
  | 'canonical-unreadable'
  | 'canonical-unavailable'
  | 'sweep-blind';

/**
 * Compare the canonical verdict against the raw sweep and name the difference.
 *
 * @param canonical - The shared probe's verdict, or `'unavailable'`.
 * @param sweepFound - What the any-slug sweep found.
 * @returns The reason the pair needs explaining, or `null` when it does not.
 */
function divergenceOf(canonical: CanonicalVerdict, sweepFound: boolean): BindingDivergence {
  switch (canonical) {
    case 'unavailable':
      return 'canonical-unavailable';
    case 'unreadable':
      return 'canonical-unreadable';
    case 'missing':
      return sweepFound ? 'stale-slug' : null;
    case 'not-applicable':
      return sweepFound ? 'runtime-keeps-no-transcript' : null;
    case 'present':
      return sweepFound ? null : 'sweep-blind';
  }
}

/**
 * Whether a session has a transcript file in any of those folders — the raw
 * any-slug sweep. A `true` from it means only that the file is on disk
 * somewhere, which includes under a project slug no resume would ever look in.
 *
 * **This is not the question a resume asks.** A resume looks under the slug of
 * the directory the agent is in NOW; this checks every slug folder for
 * `<sessionId>.jsonl` and so answers `true` for a transcript stranded under the
 * slug of a directory that has since moved — a conversation that is on disk and
 * permanently out of reach. The canonical answer beside it in the response is
 * the resume-shaped one; this is kept only because "is the file anywhere at
 * all?" is a genuinely different and useful thing to know mid-incident, and the
 * `divergence` field names it whenever the two part ways.
 *
 * (The slug IS computable from a binding — the author registry resolves the
 * agent directory behind `authorId`, which is exactly how the canonical probe
 * does it. An earlier version of this doc claimed it was not, and used that as
 * the justification for the sweep being the only option. It never was.)
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
