/**
 * Curated, privacy-safe event subset extensions may subscribe to.
 *
 * This is deliberately NOT the raw session stream. Extensions run untrusted in
 * the browser, so the host exposes only a small, typed set of lifecycle and
 * activity *summaries* — never conversation content. The client-side bridge
 * (`features/extensions/model/extension-event-bridge.ts`) is the sole producer;
 * it translates the internal `SessionEvent` / `SessionListEvent` streams into
 * these shapes and drops every content-bearing field before an extension sees
 * anything.
 *
 * ## Privacy boundary (load-bearing — do not widen without review)
 *
 * These events carry NO conversation content. Specifically excluded, forever:
 * assistant/user message text (`text_delta`, message bodies), thinking output,
 * tool-call **arguments**, tool **results**, and relay message **payloads**. An
 * extension learns *that* a tool ran and *which* tool, never *what it did*. Any
 * new field added here must survive the question "could this leak what the user
 * or agent said?" — if yes, it does not belong.
 *
 * @module @dorkos/extension-api/extension-events
 */

/**
 * Every event kind the host emits, as string discriminants. A subscriber names
 * the exact kinds it wants; a manifest declares access at kind OR category
 * granularity (see {@link ExtensionEventCategory}).
 */
export const EXTENSION_EVENT_KINDS = [
  'session.started',
  'session.ended',
  'session.switched',
  'turn.started',
  'turn.completed',
  'tool.activity',
  'relay.message',
] as const;

/** A single event-kind discriminant. */
export type ExtensionEventKind = (typeof EXTENSION_EVENT_KINDS)[number];

/**
 * Coarse categories used for manifest capability declarations. Declaring a
 * category (e.g. `'session'`) grants every kind under it (`session.started`,
 * `session.ended`, `session.switched`). The category is the segment before the
 * first `.` of a kind.
 */
export const EXTENSION_EVENT_CATEGORIES = ['session', 'turn', 'tool', 'relay'] as const;

/** A single event-category discriminant. */
export type ExtensionEventCategory = (typeof EXTENSION_EVENT_CATEGORIES)[number];

/**
 * Valid entries for `capabilities.events` in a manifest: any specific kind or
 * any category. The manifest schema validates against this exact set.
 */
export const EXTENSION_EVENT_DECLARATIONS = [
  ...EXTENSION_EVENT_KINDS,
  ...EXTENSION_EVENT_CATEGORIES,
] as const;

/** A declarable capability entry — a kind or a category. */
export type ExtensionEventDeclaration = ExtensionEventKind | ExtensionEventCategory;

/**
 * Resolve a kind's category (the segment before the first `.`). Used by the
 * gating check so a category declaration authorizes all of its kinds.
 *
 * @param kind - The event kind to categorize.
 * @returns The kind's category.
 */
export function extensionEventCategory(kind: ExtensionEventKind): ExtensionEventCategory {
  return kind.slice(0, kind.indexOf('.')) as ExtensionEventCategory;
}

/**
 * Whether a subscribe request for `kind` is authorized by a manifest's declared
 * `capabilities.events` list. Authorized when the list names the kind directly
 * OR names the kind's category.
 *
 * @param kind - The kind an extension is trying to subscribe to.
 * @param declared - The manifest's `capabilities.events` entries.
 * @returns `true` if the subscription is permitted.
 */
export function isExtensionEventDeclared(
  kind: ExtensionEventKind,
  declared: readonly ExtensionEventDeclaration[]
): boolean {
  return declared.includes(kind) || declared.includes(extensionEventCategory(kind));
}

// === Event payloads ===

/** A session became visible to the host (first observed on the session list). */
export interface ExtensionSessionStartedEvent {
  kind: 'session.started';
  /** The session's id. */
  sessionId: string;
}

/** A session was removed from the host. */
export interface ExtensionSessionEndedEvent {
  kind: 'session.ended';
  /** The session's id. */
  sessionId: string;
}

/**
 * The operator's active (foreground) session changed. Fires with the newly
 * attached session, or `null` when no session is selected.
 */
export interface ExtensionSessionSwitchedEvent {
  kind: 'session.switched';
  /** The now-active session's id, or `null` when deselected. */
  sessionId: string | null;
  /** The previously active session's id, or `null` if none was active. */
  previousSessionId: string | null;
}

/** An assistant turn began in the active session. Carries no prompt text. */
export interface ExtensionTurnStartedEvent {
  kind: 'turn.started';
  /** The session whose turn started. */
  sessionId: string;
}

/**
 * An assistant turn finished in the active session. Carries only summary
 * metrics — never the produced message text.
 */
export interface ExtensionTurnCompletedEvent {
  kind: 'turn.completed';
  /** The session whose turn completed. */
  sessionId: string;
  /**
   * Wall-clock duration of the turn in milliseconds, measured client-side from
   * `turn.started` to completion. `null` if the start was not observed (e.g. the
   * subscription began mid-turn).
   */
  durationMs: number | null;
  /** How many tool calls the turn made (client-counted). */
  toolCallCount: number;
  /**
   * Why the turn ended (e.g. `'completed'`, `'aborted_streaming'`), when the
   * runtime reports it. A coarse status string — carries no content.
   */
  terminalReason?: string;
}

/**
 * A tool started or finished in the active session. Carries the tool's NAME and
 * a coarse status only — the tool's arguments and results are deliberately
 * absent (privacy boundary).
 */
export interface ExtensionToolActivityEvent {
  kind: 'tool.activity';
  /** The session the tool ran in. */
  sessionId: string;
  /** The tool's name (e.g. `'Bash'`, `'Read'`). Never its input or output. */
  toolName: string;
  /** Coarse lifecycle phase: the tool was invoked or produced a result. */
  status: 'started' | 'completed';
}

/**
 * A relay message was observed on the human console stream. Carries routing
 * metadata only — the message PAYLOAD (its body/content) is never included.
 */
export interface ExtensionRelayMessageEvent {
  kind: 'relay.message';
  /** The relay envelope's unique id. */
  messageId: string;
  /** The sender's relay address. */
  from: string;
  /** The message subject/routing key. Not the body. */
  subject: string;
}

/**
 * Discriminated union (`kind`) of every event an extension may receive via
 * `api.events.subscribe`. Every member is a lifecycle or activity *summary*;
 * none carries conversation content (see the module-level privacy boundary).
 */
export type ExtensionEvent =
  | ExtensionSessionStartedEvent
  | ExtensionSessionEndedEvent
  | ExtensionSessionSwitchedEvent
  | ExtensionTurnStartedEvent
  | ExtensionTurnCompletedEvent
  | ExtensionToolActivityEvent
  | ExtensionRelayMessageEvent;

/**
 * The event subscription surface handed to extensions as `api.events`.
 */
export interface ExtensionEventsAPI {
  /**
   * Subscribe to a set of event kinds. The handler fires for each matching
   * event until the returned unsubscribe function is called (also called
   * automatically on extension deactivate).
   *
   * Kinds the extension did NOT declare in its manifest `capabilities.events`
   * are rejected: a console warning names them and they are silently dropped
   * from the subscription (the rest still deliver). If every requested kind is
   * undeclared the returned unsubscribe is a no-op.
   *
   * @param kinds - The event kinds to listen for.
   * @param handler - Invoked with each matching {@link ExtensionEvent}.
   * @returns An unsubscribe function.
   */
  subscribe(kinds: ExtensionEventKind[], handler: (event: ExtensionEvent) => void): () => void;
}
