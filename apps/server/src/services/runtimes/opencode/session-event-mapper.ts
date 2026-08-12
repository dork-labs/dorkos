/**
 * OpenCode session-scoped event mapping — everything the wire carries that is
 * NOT a message part: assistant usage (`message.updated`), tool approvals
 * (`permission.asked`/`permission.replied`), retry diagnostics
 * (`session.status`), turn failures (`session.error`) and todos
 * (`todo.updated`). `event-mapper.ts` routes wire events here and holds the
 * adapter-wide SOURCE OF TRUTH notes.
 *
 * Not to be confused with `session-mapper.ts`, which bridges DorkOS session ids
 * to OpenCode's `ses_*` ids; this module maps EVENTS, not identifiers.
 *
 * TOOL APPROVALS: OpenCode supportsToolApproval = TRUE, and the permission
 * shapes here are the one part of this adapter that the SDK's generated types
 * get WRONG (DOR-1147, live-verified 2026-08-11 against opencode 1.18.15).
 * The SDK declares `permission.updated` carrying a `Permission`, and
 * `permission.replied` carrying `{sessionID, permissionID, response}`. The
 * shipped server emits neither:
 *
 * - it publishes `permission.asked` with a `PermissionRequest`
 *   (`{id, sessionID, permission, patterns[], metadata, always[], tool?}`) —
 *   `permission` not `type`, `patterns[]` not `pattern`, no `title`, no
 *   `time.created`, tool ids nested under `tool`;
 * - its echo is `permission.replied` with `{sessionID, requestID, reply}`.
 *
 * `permission.updated` does not exist in the 1.18.15 binary at all, so
 * subscribing to it meant no approval card ever appeared and a gated tool hung
 * the turn forever. The shapes below are hand-typed from the sidecar's OWN
 * OpenAPI document (`GET /doc`) and confirmed against captured live payloads;
 * because they describe untyped SSE JSON, every payload is Zod-parsed before
 * it is trusted — strict on what the mapping needs, indifferent to extras, and
 * a payload that fails to parse is DROPPED rather than half-mapped (a
 * malformed ask must not become an answerable card).
 *
 * `toolCallId` carries the PERMISSION id (not `callID`): the id the client
 * echoes back through `approveTool()` is exactly what
 * `POST /session/{id}/permissions/{permissionID}` needs, so the respond wiring
 * is a direct pass-through. `hasSuggestions` is false by design: OpenCode's
 * `"always"` response would persist a rule in OpenCode's own store and diverge
 * from DorkOS's approval model, so DorkOS only offers once/reject (NOTES.md §2).
 *
 * @module services/runtimes/opencode/session-event-mapper
 */
import { z } from 'zod';
import type { AssistantMessage, Event, SessionStatus, Todo } from '@opencode-ai/sdk';
import type { SessionTaskStatus, StreamEvent, TaskItem } from '@dorkos/shared/types';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import { SESSIONS } from '../../../config/constants.js';
import { logger } from '../../../lib/logger.js';

/** The error name OpenCode stamps on interrupts — suppressed, not surfaced. */
const ABORT_ERROR_NAME = 'MessageAbortedError';

/**
 * Message signals that a turn failed because the chosen model is missing — a
 * not-installed Ollama tag, or a model a provider does not serve. OpenCode has
 * NO typed model-not-found error: the failure arrives as a generic
 * `APIError`/`UnknownError` whose `data.message` carries the provider's reason,
 * so this matches the message conservatively — only DEFINITIVE "no such model"
 * shapes, never softer wording. Verified upstream shapes: Ollama replies
 * `model "<tag>" not found, try pulling it first`; OpenRouter replies `No
 * endpoints found for <model>`.
 *
 * Deliberately excludes phrases like "temporarily not available"/"unavailable":
 * those read as transient outages a retry could clear, and telling the user to
 * pick a different model would be wrong. Everything not matched here stays a
 * generic execution error (spec §11).
 */
const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\bmodel\b[^.]*\bnot\s+found\b/i,
  /\bno\s+endpoints?\s+found\b/i,
  /\bunknown\s+model\b/i,
];

/** Plain-language turn error for an unavailable model — points at the model menu (spec §11). */
const MODEL_UNAVAILABLE_MESSAGE =
  "That model isn't available. Pick another one from the model menu.";

/** Whether a provider error message reads as an unavailable/unknown model. */
function isModelUnavailableMessage(message: string): boolean {
  return MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Session error union member shape (all variants carry `name` + `data`). */
type OpenCodeSessionError = NonNullable<
  Extract<Event, { type: 'session.error' }>['properties']['error']
>;

/**
 * message.updated → usage `session_status` once the assistant message
 * completes (`time.completed` set). In-flight updates and user messages emit
 * nothing; message-level errors are NOT mapped here — upstream `halt()`
 * publishes the same failure as `session.error`, which owns error mapping.
 *
 * @param info - The updated message
 * @param sessionId - DORKOS session id stamped onto the emitted event
 */
export function mapMessageUpdated(
  info: Extract<Event, { type: 'message.updated' }>['properties']['info'],
  sessionId: string
): StreamEvent[] {
  if (info.role !== 'assistant') return [];
  const assistant: AssistantMessage = info;
  if (assistant.time.completed === undefined) return [];
  return [
    {
      type: 'session_status',
      data: {
        sessionId,
        model: assistant.modelID,
        costUsd: assistant.cost,
        contextTokens: assistant.tokens.input,
        outputTokens: assistant.tokens.output,
        cacheReadTokens: assistant.tokens.cache.read,
        cacheCreationTokens: assistant.tokens.cache.write,
        // OpenCode fronts multiple providers with no shared quota, so it reports
        // pay-as-you-go cost (the one honest, legible signal); the active
        // provider/model names the tooltip. No utilization, no reset window.
        usage: {
          kind: 'pay-as-you-go',
          costUsd: assistant.cost,
          detail: `${assistant.providerID}/${assistant.modelID}`,
        },
      },
    },
  ];
}

/**
 * The live `permission.asked` payload (sidecar OpenAPI `PermissionRequest`).
 * `always` and `tool` are accepted but unused: DorkOS never sends OpenCode's
 * `always` response, and the approval is keyed by the PERMISSION id rather
 * than the tool call id.
 */
export const PermissionAskedPropertiesSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  always: z.array(z.string()).optional(),
  tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
});

/** Parsed `permission.asked` properties. */
export type PermissionAskedProperties = z.infer<typeof PermissionAskedPropertiesSchema>;

/**
 * The live `permission.replied` payload. The SDK's declared field names
 * (`permissionID`, `response`) are stale — the wire says `requestID`/`reply`.
 */
export const PermissionRepliedPropertiesSchema = z.object({
  sessionID: z.string(),
  requestID: z.string(),
  reply: z.string(),
});

/** Parsed `permission.replied` properties. */
export type PermissionRepliedProperties = z.infer<typeof PermissionRepliedPropertiesSchema>;

/**
 * The slice of a turn's mapping context this module owns: every forwarded ask
 * that has not been answered yet, and the OpenCode session each one must be
 * ANSWERED in.
 *
 * The reply route is per-session (`POST /session/{id}/permissions/{id}`), and a
 * subagent raises its prompts in its own CHILD session — so the turn's own
 * `ses_*` id is the wrong target for those and the adapter has to be told which
 * one asked (DOR-1126). Entries are dropped when the ask is answered
 * (`permission.replied`) and swept at the turn terminal
 * ({@link closeOpenPermissions}), so what is left is always exactly the set of
 * live questions.
 */
export interface OpenCodePermissionState {
  /** Permission id → the OpenCode session that raised it (the reply's target). */
  readonly pendingPermissionSessions: Map<string, string>;
}

/** `permission.asked` as it rides the wire — absent from the SDK's Event union. */
export interface EventPermissionAsked {
  type: 'permission.asked';
  properties: PermissionAskedProperties;
}

/** `permission.replied` as it rides the wire — the SDK's declaration is stale. */
export interface EventPermissionReplied {
  type: 'permission.replied';
  properties: PermissionRepliedProperties;
}

/**
 * permission.asked → `approval_required` (see module doc, TOOL APPROVALS).
 *
 * `startedAt` is stamped here because the payload carries no timestamp of its
 * own: the countdown the client renders is the server's auto-deny timer, and
 * that timer starts when the adapter sees the request. `title` is omitted
 * rather than invented — 1.18.15 sends no prompt sentence, and the card reads
 * perfectly well from the tool name and its input.
 *
 * Permission-mode enforcement (auto-answering under
 * `acceptEdits`/`bypassPermissions`) is the facade's job — this surfaces every
 * request it is handed.
 *
 * @param properties - Raw `permission.asked` properties off the wire
 * @param state - The turn's permission bookkeeping (mutated: an ask that
 *   becomes a card records the session its answer must be sent to)
 * @param title - Header sentence for the card. The subagent path passes one so
 *   the prompt says who is asking (DOR-1126); a session's own prompts pass
 *   none, because 1.18.15 sends no prompt sentence and the card reads perfectly
 *   well from the tool name and its input.
 */
export function mapPermissionAsked(
  properties: unknown,
  state: OpenCodePermissionState,
  title?: string
): StreamEvent[] {
  const parsed = PermissionAskedPropertiesSchema.safeParse(properties);
  if (!parsed.success) {
    logger.warn('[OpenCode] unparseable permission.asked — dropped', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return [];
  }
  const { id, sessionID, permission, patterns, metadata } = parsed.data;
  state.pendingPermissionSessions.set(id, sessionID);
  // An `edit` request names the file it wants to touch (`metadata.filepath`,
  // live-verified) — the one piece of metadata the approval card has a field for.
  const filepath = metadata['filepath'];
  return [
    {
      type: 'approval_required',
      data: {
        toolCallId: id,
        toolName: permission,
        ...(title !== undefined ? { title } : {}),
        input: JSON.stringify({ ...(patterns.length > 0 ? { patterns } : {}), ...metadata }),
        timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
        startedAt: Date.now(),
        ...(typeof filepath === 'string' ? { blockedPath: filepath } : {}),
        hasSuggestions: false,
      },
    },
  ];
}

/**
 * The only `reply` strings the shipped sidecar has been observed to send
 * (NOTES.md §2): DorkOS itself only ever sends `once`/`reject`, but the echo
 * can carry `always` too — the OpenCode TUI or another client can answer that
 * way, and it means the same yes `once` does. An unrecognized string (a future
 * sidecar addition) maps to `undefined` rather than a guess.
 */
const APPROVAL_REASON_BY_REPLY: Readonly<Record<string, 'approved' | 'denied'>> = {
  once: 'approved',
  always: 'approved',
  reject: 'denied',
};

/**
 * permission.replied → `interaction_cancelled`, so a request answered
 * somewhere else (OpenCode's own TUI, another DorkOS client) stops showing as
 * an answerable card here. Carries the echo's `reply` forward as `reason`
 * (DOR-1148) so a card answered outside DorkOS earns the SAME
 * Approved/Denied receipt one answered inside DorkOS does — before this, every
 * echo mapped to a bare clear and a TUI-answered ask left no receipt at all.
 *
 * @param properties - Raw `permission.replied` properties off the wire
 * @param state - The turn's permission bookkeeping (mutated: the answered ask
 *   is no longer live, so the terminal sweep must not withdraw it a second time)
 */
export function mapPermissionReplied(
  properties: unknown,
  state: OpenCodePermissionState
): StreamEvent[] {
  const parsed = PermissionRepliedPropertiesSchema.safeParse(properties);
  if (!parsed.success) {
    logger.warn('[OpenCode] unparseable permission.replied — dropped', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return [];
  }
  state.pendingPermissionSessions.delete(parsed.data.requestID);
  const reason = APPROVAL_REASON_BY_REPLY[parsed.data.reply];
  return [
    {
      type: 'interaction_cancelled',
      data: {
        interactionId: parsed.data.requestID,
        ...(reason !== undefined ? { reason } : {}),
      },
    },
  ];
}

/**
 * Withdraw every ask this turn raised and never saw answered, as the turn
 * terminates. The turn mapper calls this ONLY on the authoritative terminal —
 * the parent's `session.idle` — and yields the result before it, mirroring
 * {@link closeOpenSubagents} in `subagent-mapper.ts`.
 *
 * A card outstanding here is a ghost, not a question: `session.idle` is
 * published only once the runner has drained, so a live ask cannot coexist with
 * it (a gated tool blocks its own session's loop, and a subagent's ask blocks
 * the parent's `task` call in turn). What CAN reach here is an ask the user
 * stopped the turn on — the abort kills the request upstream — or one that was
 * answered so late its echo never landed. Either way the adapter has already
 * dropped the pending record by the time the card would be clicked, so the
 * answer would fail; saying "withdrawn" is the honest end.
 *
 * Only on `session.idle`, for the same reason `closeOpenSubagents` is: every
 * other way a turn ends means DorkOS STOPPED WATCHING. There the ask may well
 * still be live, and its auto-deny timer is the thing that should answer it.
 *
 * @param state - The turn's permission bookkeeping (drained)
 */
export function* closeOpenPermissions(state: OpenCodePermissionState): Generator<StreamEvent> {
  for (const permissionId of state.pendingPermissionSessions.keys()) {
    yield { type: 'interaction_cancelled', data: { interactionId: permissionId } };
  }
  state.pendingPermissionSessions.clear();
}

/**
 * session.status → non-terminal diagnostics only. `retry` surfaces as a
 * `system_status` line (the shape lacks `maxRetries`, so `api_retry` cannot
 * be populated honestly); `busy` is implicit in the turn being live; `idle`
 * is deliberately ignored — `session.idle` (always published immediately
 * after) is the single terminal, avoiding a double `done`.
 *
 * @param status - The reported session status
 */
export function mapSessionStatus(status: SessionStatus): StreamEvent[] {
  if (status.type !== 'retry') return [];
  return [
    {
      type: 'system_status',
      data: { message: `Retrying after error (attempt ${status.attempt}): ${status.message}` },
    },
  ];
}

/**
 * session.error → typed non-terminal `error` (the turn still terminates via
 * the `session.idle` that upstream `halt()` publishes right after). The
 * interrupt shape (`MessageAbortedError`) is suppressed entirely — aborts are
 * user-initiated, not failures.
 *
 * @param error - The reported session error, if the wire carried one
 */
export function mapSessionError(error: OpenCodeSessionError | undefined): StreamEvent[] {
  if (error === undefined) {
    return [
      {
        type: 'error',
        data: {
          message: 'OpenCode reported a session error',
          code: 'session_error',
          category: 'execution_error',
        },
      },
    ];
  }
  if (error.name === ABORT_ERROR_NAME) return [];
  const data: Record<string, unknown> = error.data;
  const message =
    typeof data.message === 'string' && data.message.length > 0 ? data.message : error.name;
  // An unavailable/unknown model is the one provider failure with a plain-language
  // remedy: pick another model. Map it to friendly copy pointing at the model menu
  // instead of leaking the raw sidecar/provider string (spec §11).
  if (isModelUnavailableMessage(message)) {
    return [
      {
        type: 'error',
        data: {
          message: MODEL_UNAVAILABLE_MESSAGE,
          code: 'model_unavailable',
          category: 'execution_error',
        },
      },
    ];
  }
  return [
    {
      type: 'error',
      data: {
        message,
        code: error.name,
        category: detectAuthError({ message, code: error.name }) ? 'auth_error' : 'execution_error',
      },
    },
  ];
}

/** OpenCode todo status → DorkOS task status; `cancelled` entries are dropped. */
function mapTodoStatus(status: string): SessionTaskStatus {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
}

/**
 * Project OpenCode todos onto DorkOS task items. Cancelled todos are dropped
 * rather than mis-labeled (DorkOS task status has no cancelled member).
 * Shared by the turn stream (`todo.updated`) and the facade's
 * `getSessionTasks` (`GET /session/{id}/todo` — the same Todo shape).
 */
export function mapOpenCodeTodos(todos: Todo[]): TaskItem[] {
  return todos
    .filter((entry) => entry.status !== 'cancelled')
    .map((entry) => ({
      id: entry.id,
      subject: entry.content,
      status: mapTodoStatus(entry.status),
    }));
}

/**
 * todo.updated → `task_update` snapshot, mirroring the Codex/Claude TodoWrite
 * mapping; an empty result emits nothing.
 *
 * @param todos - The full todo list the wire event carried
 */
export function mapTodos(todos: Todo[]): StreamEvent[] {
  const tasks = mapOpenCodeTodos(todos);
  if (tasks.length === 0) return [];
  return [{ type: 'task_update', data: { action: 'snapshot', task: tasks[0]!, tasks } }];
}
