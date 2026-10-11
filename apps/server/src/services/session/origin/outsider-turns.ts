/**
 * Whether the turn running in a chat was started by somebody from off this
 * machine: a bridged Telegram or Slack sender, an external room author, an
 * outside agent over A2A, or a connector event (PRINCIPLES §1: trust never
 * extends to strangers).
 *
 * The turn origin decides a session row's power once, at binding; it says
 * nothing about a later turn. So a capability handler that must behave
 * differently for a stranger's turn (`commitments_list`, which would otherwise
 * read every agent's promises to whoever asked) reads this instead, through
 * `CapabilityHandlerContext.turnStartedByOutsider`.
 *
 * Two sources, newest first:
 *
 * 1. **What the last binding call said** ({@link noteTurnOrigin}), recorded by
 *    `runtimeRegistry.persistSessionRuntime`, which every turn-starting surface
 *    calls with its origin. A room turn calls it on every turn, so a local
 *    author's turn after a stranger's is read as the local author's.
 *
 *    A message sent to a chat (`launch-session.ts`) is bound when it is POSTED,
 *    which is not when its turn runs: it may wait in the queue behind a turn
 *    somebody else started. So that path holds the note under the message's
 *    id ({@link holdTurnOriginFor}) and it takes effect when the dispatcher
 *    reports that message's turn `started` ({@link messageTurnStarted}). A
 *    person's message queued behind a stranger's running turn cannot make that
 *    turn read as theirs. A message that joins the running turn instead
 *    (a steer) can only make it read as a stranger's, never the reverse.
 * 2. **What started the chat**, the stored `launchOrigin`, for a chat this
 *    process has not seen a turn of since it started — a bridged chat binds
 *    once, and its later turns after a restart are still a stranger's.
 *
 * Keyed by the id the dispatcher files a chat under ({@link primaryOf}).
 *
 * @module services/session/origin/outsider-turns
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { primaryOf } from '../resolution/session-key-registry.js';
import type { TurnOrigin } from './turn-origin.js';

/** Origins whose every turn is a stranger's. A room turn depends on its author. */
const OUTSIDER_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  'relay-binding',
  'outside-sender',
  'connector-event',
]);

/** Filing id → whether the chat's latest turn is a stranger's. */
const latest = new Map<string, boolean>();

/** Messages bound but not yet running: message id → whether a stranger sent it. */
const pending = new Map<string, boolean>();

/** The most held notes kept; the oldest go first (a message that never ran). */
const PENDING_MAX = 1000;

/** The message whose binding call is running, while it runs. */
const holdingFor = new AsyncLocalStorage<string>();

/** Reads a chat's stored launch origin; set by the runtime registry at startup. */
let launchOriginOf: ((sessionId: string) => string | null) | undefined;

/**
 * Whether a turn with this origin was started by somebody from off this machine.
 *
 * @param origin - The turn's origin.
 */
export function isOutsiderOrigin(origin: TurnOrigin): boolean {
  if (origin.kind === 'room') return origin.externalAuthor;
  return OUTSIDER_ORIGIN_KINDS.has(origin.kind);
}

/**
 * Record what started the turn about to run in this chat.
 *
 * @param sessionId - The chat.
 * @param origin - What is starting the turn.
 */
export function noteTurnOrigin(sessionId: string, origin: TurnOrigin): void {
  const messageId = holdingFor.getStore();
  if (messageId === undefined) {
    latest.set(primaryOf(sessionId), isOutsiderOrigin(origin));
    return;
  }
  pending.set(messageId, isOutsiderOrigin(origin));
  if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value as string);
}

/**
 * Run a message's binding call with its note held for that message's turn.
 *
 * @param messageId - The message being sent.
 * @param fn - The binding call.
 */
export function holdTurnOriginFor<T>(messageId: string, fn: () => T): T {
  return holdingFor.run(messageId, fn);
}

/**
 * A message's turn began: what it said about its sender is now the chat's.
 *
 * @param sessionId - The chat.
 * @param messageId - The message the turn started with.
 */
export function messageTurnStarted(sessionId: string, messageId: string): void {
  const outsider = pending.get(messageId);
  if (outsider === undefined) return;
  pending.delete(messageId);
  latest.set(primaryOf(sessionId), outsider);
}

/**
 * What became of a message once the dispatcher took it. Queued, it waits for
 * its own `started`; joined to the running turn, a stranger's makes that turn a
 * stranger's; refused, its note is forgotten.
 *
 * @param sessionId - The chat.
 * @param messageId - The message.
 * @param result - Whether it was accepted, and how it was applied.
 */
export function messageDispatched(
  sessionId: string,
  messageId: string,
  result: { accepted: boolean; applied?: string }
): void {
  const outsider = pending.get(messageId);
  if (outsider === undefined) return;
  if (result.accepted && result.applied === 'queue') return;
  pending.delete(messageId);
  if (result.accepted && outsider) latest.set(primaryOf(sessionId), true);
}

/**
 * Forget a held note: its message left the queue without running.
 *
 * @param messageId - The message.
 */
export function forgetMessageOrigin(messageId: string): void {
  pending.delete(messageId);
}

/**
 * Teach this module how to read a chat's stored launch origin.
 *
 * @param reader - Returns the stored origin kind, or null when none is stored.
 */
export function setLaunchOriginReader(reader: (sessionId: string) => string | null): void {
  launchOriginOf = reader;
}

/**
 * Whether the turn running in this chat was started by a stranger.
 *
 * @param sessionId - The chat, by either id it is known by.
 */
export function turnStartedByOutsider(sessionId: string): boolean {
  const noted = latest.get(primaryOf(sessionId));
  if (noted !== undefined) return noted;
  let stored: string | null = null;
  try {
    stored = launchOriginOf?.(sessionId) ?? null;
  } catch {
    // No database (tests, early boot): nothing stored to read.
  }
  return stored !== null && OUTSIDER_ORIGIN_KINDS.has(stored);
}

/**
 * Forget every noted turn and the reader.
 *
 * @internal Exported for testing only.
 */
export function resetOutsiderTurns(): void {
  latest.clear();
  pending.clear();
  launchOriginOf = undefined;
}
