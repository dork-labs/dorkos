/**
 * OpenCode event mapper — pure functions translating `@opencode-ai/sdk` SSE
 * events into DorkOS StreamEvents (`packages/shared/src/schemas.ts`).
 *
 * SOURCE OF TRUTH: SDK v1.17.13 generated types (`dist/gen/types.gen.d.ts`,
 * 32-member `Event` union) cross-checked against the upstream server source
 * at tag `v1.17.13` (`anomalyco/opencode`, `packages/opencode/src/session/
 * {processor,session,status,run-state}.ts` and the httpapi event handlers).
 *
 * This module owns the demux, the per-turn context and the dispatch; the
 * per-shape mapping lives in three siblings, each carrying the upstream notes
 * for its own domain: `part-event-mapper.ts` (text/reasoning/tool parts and
 * DELTA SEMANTICS), `session-event-mapper.ts` (usage, approvals, status,
 * errors, todos) and `subagent-mapper.ts` (the `task` tool and its child
 * session).
 *
 * DEMUX (one global stream, many sessions): the adapter subscribes ONCE per
 * runtime to `client.global.event()` and filters per session with
 * {@link matchesOpenCodeSession} on `{directory, sessionID}` — per-directory
 * `/event` subscriptions lazily boot instances and are avoided (NOTES.md §1).
 * The filter matches on the OPENCODE session id (`ses_*`), while emitted
 * StreamEvents are stamped with the DORKOS session id supplied to
 * {@link createOpenCodeEventContext} — the two ids are DIFFERENT namespaces,
 * bridged by `session-mapper.ts` at the subscription site (task 3.6).
 *
 * TURN-END VERDICT (upstream evidence): `session.idle` is the authoritative
 * turn terminal. `SessionStatus.set(sessionID, {type:"idle"})` (`status.ts`)
 * always publishes `session.status{idle}` AND `session.idle`; it fires on
 * success (runner drain, `run-state.ts#onIdle`), on failure
 * (`processor.ts#halt` → `session.error` then idle), and on interrupt/cancel
 * (`run-state.ts#cancel`). The mapper maps `session.idle` → terminal `done`
 * and deliberately ignores `session.status{idle}` (which always precedes it)
 * to avoid double terminals.
 *
 * ABORT SHAPE: an interrupt surfaces as `session.error` carrying
 * `MessageAbortedError` followed by `session.idle`. Aborts are user-initiated,
 * not failures, so that error name is suppressed and the turn ends with a
 * plain `done` — mirroring the Codex mapper's AbortError handling.
 *
 * SUBAGENTS: a subagent run is carried by an ordinary `task` tool part in the
 * PARENT session plus the events of the CHILD session it creates (NOTES.md §7).
 * This module admits the child session through
 * {@link matchesOpenCodeSubagentSession} and routes its events away from the
 * parent mapping entirely — its tool calls are reported on the parent's
 * background-task card, and its permission prompts on the parent's prompt
 * surface, named for the subagent that raised them (DOR-1126). Child text,
 * todos and terminals are deliberately dropped: only the parent session may
 * write the transcript or end the turn.
 *
 * @module services/runtimes/opencode/event-mapper
 */
import type { Event, GlobalEvent } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  mapPartDelta,
  mapPartSnapshot,
  type EventMessagePartDelta,
  type OpenCodePartState,
} from './part-event-mapper.js';
import {
  closeOpenPermissions,
  mapMessageUpdated,
  mapPermissionAsked,
  mapPermissionReplied,
  mapSessionError,
  mapSessionStatus,
  mapTodos,
  type EventPermissionAsked,
  type EventPermissionReplied,
  type OpenCodePermissionState,
} from './session-event-mapper.js';
import {
  closeOpenSubagents,
  isSubagentRunning,
  mapSubagentChildToolPart,
  subagentPromptTitle,
} from './subagent-mapper.js';

/**
 * Everything the wire can carry: the SDK union, minus the two permission
 * members whose generated shapes the shipped server contradicts, plus the
 * events hand-typed against the live 1.18.15 wire ({@link EventPermissionAsked},
 * {@link EventPermissionReplied} in `session-event-mapper.ts`, and
 * {@link EventMessagePartDelta} in `part-event-mapper.ts`). The exclusion is
 * deliberate — leaving the stale members in would let this mapper compile
 * against a payload the sidecar has never sent (DOR-1147).
 */
export type OpenCodeWireEvent =
  | Exclude<Event, { type: 'permission.updated' | 'permission.replied' }>
  | EventMessagePartDelta
  | EventPermissionAsked
  | EventPermissionReplied;

/**
 * Per-turn mutable state threaded through the pure mapping functions —
 * the OpenCode analog of the Codex adapter's `CodexEventContext`. The
 * per-shape bookkeeping (delta baselines, tool guards, subagent runs) is
 * declared by the sibling modules that own it.
 */
export interface OpenCodeEventContext extends OpenCodePartState, OpenCodePermissionState {
  /**
   * DORKOS session id stamped onto done/session_status events. NOT the
   * OpenCode `ses_*` id — the demux filter matches on that one; the caller
   * (3.6) bridges the namespaces via the session mapper.
   */
  readonly sessionId: string;
}

/**
 * Create a fresh mapping context for one turn.
 *
 * @param sessionId - DORKOS session identifier stamped onto emitted events
 *   (not the OpenCode `ses_*` id — see {@link OpenCodeEventContext.sessionId})
 */
export function createOpenCodeEventContext(sessionId: string): OpenCodeEventContext {
  return {
    sessionId,
    lastTextByPartId: new Map(),
    partKindById: new Map(),
    startedToolCallIds: new Set(),
    endedToolCallIds: new Set(),
    subagentRuns: new Map(),
    subagentTaskIdBySession: new Map(),
    pendingPermissionSessions: new Map(),
  };
}

/**
 * Extract the OpenCode session id an event belongs to — the sessionID half
 * of the `{directory, sessionID}` demux key. Returns undefined for events
 * that are not session-scoped (installation, lsp, tui, pty, files, vcs…).
 */
export function extractOpenCodeSessionId(event: OpenCodeWireEvent): string | undefined {
  switch (event.type) {
    case 'message.updated':
      return event.properties.info.sessionID;
    case 'message.part.updated':
      return event.properties.part.sessionID;
    case 'message.part.delta':
    case 'message.removed':
    case 'message.part.removed':
    case 'permission.asked':
    case 'permission.replied':
    case 'session.status':
    case 'session.idle':
    case 'session.compacted':
    case 'session.diff':
    case 'session.error':
    case 'todo.updated':
    case 'command.executed':
      return event.properties.sessionID;
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id;
    default:
      return undefined;
  }
}

/**
 * The per-session demux filter for the ONE `client.global.event()`
 * subscription: an event belongs to a session iff BOTH the envelope
 * directory and the payload's OpenCode session id match (NOTES.md §1).
 *
 * @param globalEvent - `{directory, payload}` envelope from `/global/event`
 * @param directory - The session's working directory (as stored by OpenCode)
 * @param opencodeSessionId - The OpenCode-native `ses_*` id (from session-mapper)
 */
export function matchesOpenCodeSession(
  globalEvent: GlobalEvent,
  directory: string,
  opencodeSessionId: string
): boolean {
  if (globalEvent.directory !== directory) return false;
  return extractOpenCodeSessionId(globalEvent.payload as OpenCodeWireEvent) === opencodeSessionId;
}

/**
 * The companion demux filter for a subagent's CHILD session: true once a `task`
 * tool part in this turn has revealed the child session id and before the
 * subagent's terminal clears it. OR this with {@link matchesOpenCodeSession} at
 * the subscription site so the parent turn can report what its subagents are
 * doing (`background_task_progress`).
 *
 * Learning is done by the mapper, which sees events only after they are
 * admitted, so a child event that arrives before the mapper has drained the
 * metadata snapshot is dropped. That costs progress beats, never correctness:
 * the subagent's start and terminal ride the PARENT session, which is always
 * admitted.
 *
 * @param globalEvent - `{directory, payload}` envelope from `/global/event`
 * @param directory - The session's working directory (as stored by OpenCode)
 * @param ctx - The turn's mapping context (holds the known child sessions)
 */
export function matchesOpenCodeSubagentSession(
  globalEvent: GlobalEvent,
  directory: string,
  ctx: OpenCodeEventContext
): boolean {
  if (ctx.subagentTaskIdBySession.size === 0) return false;
  if (globalEvent.directory !== directory) return false;
  const sessionId = extractOpenCodeSessionId(globalEvent.payload as OpenCodeWireEvent);
  return sessionId !== undefined && ctx.subagentTaskIdBySession.has(sessionId);
}

/**
 * Map one OpenCode wire event to zero or more StreamEvents. Pure aside from
 * the mutable {@link OpenCodeEventContext} (delta baselines, tool guards).
 *
 * `session.idle` is the only event that emits the terminal `done`;
 * {@link mapOpenCodeTurn} guarantees that invariant for whole streams,
 * including aborted or crashed ones.
 *
 * Ignore-list default (documented, not exhaustive-checked — the 32-member
 * union plus wire-only extras like `server.heartbeat` make a `never` check
 * counterproductive): `server.instance.disposed`, `installation.*`, `lsp.*`,
 * `message.removed`, `message.part.removed`, `session.created/updated/
 * deleted` (session-list watcher domain, not the turn stream),
 * `session.diff`, `file.edited`, `file.watcher.updated`, `command.executed`,
 * `vcs.branch.updated`, `tui.*`, `pty.*`, `server.connected`, and any
 * undeclared wire type (e.g. `server.heartbeat`).
 *
 * @param event - The OpenCode wire event to translate
 * @param ctx - Per-turn mapping context (mutated)
 */
export function mapOpenCodeEvent(
  event: OpenCodeWireEvent,
  ctx: OpenCodeEventContext
): StreamEvent[] {
  // A subagent's child session speaks only through its parent's task card:
  // route it away from the parent-session mapping entirely, so its text never
  // lands in the transcript and its `session.idle` never ends the parent turn.
  const subagentTaskId = resolveSubagentTaskId(event, ctx);
  if (subagentTaskId !== undefined) return mapSubagentChildEvent(event, subagentTaskId, ctx);

  switch (event.type) {
    case 'message.part.updated':
      return mapPartSnapshot(event.properties.part, ctx);
    case 'message.part.delta':
      return mapPartDelta(event.properties, ctx);
    case 'message.updated':
      return mapMessageUpdated(event.properties.info, ctx.sessionId);
    case 'permission.asked':
      return mapPermissionAsked(event.properties, ctx);
    case 'permission.replied':
      // Resolution echo (possibly from another client, e.g. the TUI) — clear
      // the pending approval card instead of leaving an answerable ghost.
      return mapPermissionReplied(event.properties, ctx);
    case 'session.status':
      return mapSessionStatus(event.properties.status);
    case 'session.idle':
      // The authoritative turn terminal (see module doc, TURN-END VERDICT).
      return [{ type: 'done', data: { sessionId: ctx.sessionId } }];
    case 'session.compacted':
      // OpenCode reports compaction as a single post-hoc completion — it exposes
      // no start signal and no percent, so honest degradation is a lone
      // `operation_progress` `done` (DOR-110) plus the durable `compact_boundary`
      // row. No metadata upstream — an empty boundary still renders the marker.
      return [
        {
          type: 'operation_progress',
          data: { operation: 'compaction', state: 'done', determinate: false },
        },
        { type: 'compact_boundary', data: {} },
      ];
    case 'session.error':
      return mapSessionError(event.properties.error);
    case 'todo.updated':
      return mapTodos(event.properties.todos);
    default:
      // Documented ignore list — see the function doc above.
      return [];
  }
}

/**
 * Map a whole demuxed per-session event stream, guaranteeing the conformance
 * invariant that exactly one terminal `done` ends the StreamEvent stream:
 *
 * - after `done` (`session.idle`) the generator returns without pulling more,
 *   closing any subagent the wire left open first ({@link closeOpenSubagents});
 * - an AbortError (subscription torn down mid-turn) ends the turn with a
 *   plain `done` — user-initiated, not an error;
 * - any other thrown error (e.g. the sidecar dying) becomes a typed `error`
 *   followed by `done`;
 * - a stream that ends without `session.idle` still gets its trailing `done`
 *   so consumers can key turn teardown on it.
 *
 * @param events - Demuxed per-session wire events (from the global stream)
 * @param ctx - Per-turn mapping context (mutated)
 */
export async function* mapOpenCodeTurn(
  events: AsyncIterable<OpenCodeWireEvent>,
  ctx: OpenCodeEventContext
): AsyncGenerator<StreamEvent> {
  try {
    for await (const event of events) {
      for (const mapped of mapOpenCodeEvent(event, ctx)) {
        if (mapped.type === 'done') {
          yield* closeOpenPermissions(ctx);
          yield* closeOpenSubagents(ctx);
          yield mapped;
          return;
        }
        yield mapped;
      }
    }
  } catch (err) {
    if (!isAbortError(err)) {
      yield {
        type: 'error',
        data: {
          message: err instanceof Error ? err.message : String(err),
          code: 'stream_error',
          category: 'execution_error',
        },
      };
    }
  }
  yield { type: 'done', data: { sessionId: ctx.sessionId } };
}

// === Subagent routing (the `task` tool) ===

/**
 * The `task` callID a wire event belongs to when it came from a live subagent's
 * child session, or undefined when it belongs to the parent session.
 */
function resolveSubagentTaskId(
  event: OpenCodeWireEvent,
  ctx: OpenCodeEventContext
): string | undefined {
  if (ctx.subagentTaskIdBySession.size === 0) return undefined;
  const sessionId = extractOpenCodeSessionId(event);
  if (sessionId === undefined) return undefined;
  return ctx.subagentTaskIdBySession.get(sessionId);
}

/**
 * Map one event from a subagent's child session onto its parent's surfaces:
 * its tool calls become progress beats on the parent's task card, and its
 * PERMISSION PROMPTS become approval cards on the parent session, labelled with
 * the subagent's name (DOR-1126) — the parent's prompt surface owns them
 * because the child session has none of its own.
 *
 * Everything else the child emits (text, reasoning, todos, its own terminal) is
 * dropped: the child is not the turn, and its `session.idle` must never be
 * mistaken for the parent's.
 *
 * A run that already reported its terminal reports nothing more. A prompt from
 * a finished subagent would be a card nobody can act on, exactly as a late tool
 * part would be a beat on a card that has settled.
 */
function mapSubagentChildEvent(
  event: OpenCodeWireEvent,
  taskId: string,
  ctx: OpenCodeEventContext
): StreamEvent[] {
  switch (event.type) {
    case 'permission.asked':
      if (!isSubagentRunning(ctx, taskId)) return [];
      return mapPermissionAsked(event.properties, ctx, subagentPromptTitle(ctx, taskId));
    case 'permission.replied':
      // The child's own resolution echo — its card lives on the parent session,
      // so it is cleared exactly like one the parent raised.
      return mapPermissionReplied(event.properties, ctx);
    case 'message.part.updated': {
      const part = event.properties.part;
      if (part.type !== 'tool') return [];
      return mapSubagentChildToolPart(part, taskId, ctx);
    }
    default:
      return [];
  }
}

/** True when the thrown value is an AbortError (subscription teardown). */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}
