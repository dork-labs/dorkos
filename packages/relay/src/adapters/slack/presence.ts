/**
 * Slack working-presence — the "somebody is on it" indicator, driven by the turn.
 *
 * Slack has no bot typing API, so this module carries two honest mappings and
 * picks between them by surface:
 *
 * - **Assistant split-panel threads**: `assistant.threads.setStatus`, the only
 *   place Slack offers a first-class status line. Set at claim, updated once
 *   when the turn runs long, cleared at the terminal.
 * - **Everywhere else**: an `:eyes:` reaction on the message that triggered the
 *   turn — the documented Slack convention for "seen, on it" — added at claim
 *   and removed at the terminal.
 *
 * Both are keyed to the **claim**: the first runtime event of a real turn, not
 * the arrival of a message. A message that never triggers anything shows
 * nothing, which is the whole point (`meta/agent-etiquette.md` E16a).
 *
 * There is no success or failure emoji. The terminal is the reply, or the
 * relayed error, and a reaction vocabulary with terminals is a state machine
 * nobody audits.
 *
 * @module relay/adapters/slack/presence
 */
import type { WebClient } from '@slack/web-api';
import type { RelayLogger } from '../../types.js';

// === Constants ===

/** The reaction that means "seen, on it" — Slack's own convention. */
export const PRESENCE_EMOJI = 'eyes';

/** Status text shown on the assistant surface while a turn is running. */
export const WORKING_STATUS = 'is working on it…';

/** Status text shown once a turn has run long. */
export const WORKING_LATE_STATUS = 'still working — taking longer than usual';

/**
 * How often a held claim restates itself (ms).
 *
 * Slack auto-clears an assistant status after 2 minutes — a platform-side TTL
 * that suits this design, because a server that dies mid-turn leaves at most
 * that much dishonesty behind. Refreshing well inside it keeps the status alive
 * for exactly as long as the claim is.
 */
export const PRESENCE_REFRESH_MS = 45_000;

/**
 * How long a claim's stream may go silent before presence releases itself (ms).
 *
 * A terminal is not guaranteed: the upstream `done` is best-effort and a
 * stalled stream may never reach the code that emits one. Without this bound,
 * one lost terminal leaves `:eyes:` on a message forever. Every event of the
 * turn restates it, so a turn that reports in is never cut — only a stream that
 * has gone dark is. Same value and same reasoning as the Telegram loop's
 * `TYPING_INACTIVITY_MS`.
 */
export const PRESENCE_INACTIVITY_MS = 60_000;

/**
 * How long a turn runs before the assistant status says so (ms).
 *
 * Anchored to Slack's own 2-minute status TTL: a turn that outlives the window
 * the platform considers a normal wait has, by the platform's own measure, run
 * long. Said once per **turn**, not per claim — a turn that pauses on a question
 * and resumes does not get to announce its lateness twice, and a status that
 * keeps announcing it is noise rather than information.
 */
export const PRESENCE_LATE_MS = 120_000;

/**
 * How long after a turn ends its own trailing events are still ignored (ms).
 *
 * The runtime event vocabulary is open, so a turn can emit something after its
 * `done` — and a claim from that would take the next person's message off the
 * FIFO and mark it. Two turns in one Slack thread share a stream key, though, so
 * this cannot be permanent: past the grace, a claim is a person's next question,
 * not an echo of the last one. The cost of getting it wrong is one un-marked
 * turn, for a follow-up asked and answered within five seconds of the last.
 */
export const SETTLED_GRACE_MS = 5_000;

/** How long a queued trigger message waits for a claim before it is forgotten (ms). */
export const PENDING_REACTION_TTL_MS = 5 * 60 * 1_000;

/** Cap on remembered assistant threads, so a long-lived adapter cannot grow without bound. */
const MAX_ASSISTANT_THREADS = 1_000;

/**
 * How long a binding with nothing running behind it is kept (ms).
 *
 * A turn that pauses on a question keeps its binding on purpose — that is what
 * stops the resume stealing the next person's message — but a person who never
 * answers is the normal case, not a rare one, and that binding would otherwise
 * be held for the life of the process. Generous, because the cost of dropping
 * one early is that a very late resume marks the wrong message, and the cost of
 * holding it is a few dozen bytes.
 */
export const ABANDONED_BINDING_TTL_MS = 60 * 60 * 1_000;

/** Hard cap on remembered turns, for the pathological case the TTL is too slow for. */
const MAX_BINDINGS = 1_000;

// === Types ===

/**
 * FIFO queue of trigger messages awaiting a claim, keyed by channelId.
 *
 * The inbound handler pushes a message's `ts` when it publishes it; the claim
 * shifts the oldest one and reacts to it. Queuing at receipt but reacting at
 * claim is what lets interleaved turns in one channel each mark the message
 * they are actually answering — Slack tells the outbound side nothing about
 * which message a turn came from.
 */
type PendingReactions = Map<string, { ts: string; queuedAt: number }[]>;

/**
 * What a turn is bound to, for as long as the turn lasts.
 *
 * Separate from the claim on purpose. A turn can pause — it stops to ask a
 * person something — and the indicator must come off while it waits, but the
 * **binding must not**: the message this turn is answering was taken off the
 * FIFO once, and a resumed turn has to mark that same message rather than
 * stealing the next person's. Only a real terminal settles a binding.
 */
interface TurnBinding {
  /** The thread the turn is answering in, when there is one. */
  threadTs: string | undefined;
  /** True when this thread is an assistant split panel, where a status line exists. */
  assistant: boolean;
  /** The message `ts` this turn's `:eyes:` belongs on, if one was queued for it. */
  messageTs: string | undefined;
  /** Whether an indicator is on screen right now. */
  shown: boolean;
  /** Whether this turn has already said it is running long — said once, not per resume. */
  late: boolean;
  /** When the turn reached a terminal, or undefined while it is still live. */
  settledAt: number | undefined;
  /** When this binding was last claimed or released — the abandonment sweep reads it. */
  touchedAt: number;
}

/** One held claim — a turn this adapter can see running right now. */
interface ActivePresence {
  /** The client this turn's last event arrived with, re-read on every event. */
  client: WebClient;
  /** When this claim's stream last said anything — the inactivity bound reads it. */
  lastEventAt: number;
  refresh: ReturnType<typeof setInterval> | undefined;
  lateTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Slack presence state, scoped to a single adapter instance. */
export interface SlackPresenceState {
  /** Held claims, keyed `${channelId}:${streamKeyTs}` — one per turn in flight. */
  active: Map<string, ActivePresence>;
  /** What each turn is bound to, keyed the same way; outlives a pause, not a terminal. */
  bindings: Map<string, TurnBinding>;
  /** Trigger messages awaiting a claim. */
  pendingReactions: PendingReactions;
  /** Threads known to be assistant split panels, keyed `${channelId}:${threadTs}`. */
  assistantThreads: Map<string, number>;
}

/** What a claim or release needs to talk to Slack. */
export interface PresenceContext {
  client: WebClient | null;
  channelId: string;
  threadTs: string | undefined;
  /** The per-turn stream key — the same value that keys the stream buffer. */
  streamKeyTs: string;
  typingIndicator: 'none' | 'reaction';
  state: SlackPresenceState;
  logger?: RelayLogger;
}

// === State ===

/** Create a fresh presence state container for a new adapter instance. */
export function createSlackPresenceState(): SlackPresenceState {
  return {
    active: new Map(),
    bindings: new Map(),
    pendingReactions: new Map(),
    assistantThreads: new Map(),
  };
}

/** Key a claim by channel and turn. */
function presenceKey(channelId: string, streamKeyTs: string): string {
  return `${channelId}:${streamKeyTs}`;
}

/** Key a thread. */
function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

// === Assistant surface ===

/**
 * Remember that a thread is an assistant split panel.
 *
 * Called from the `assistant_thread_started` event, which is the only thing
 * that identifies the surface. A restarted adapter forgets, and threads it has
 * not seen start in fall back to the reaction mapping — a visible but honest
 * degradation, not a wrong claim.
 *
 * @param state - The adapter's presence state
 * @param channelId - The Slack channel the thread lives in
 * @param threadTs - The thread's root timestamp
 */
export function markAssistantThread(
  state: SlackPresenceState,
  channelId: string,
  threadTs: string
): void {
  const key = threadKey(channelId, threadTs);
  state.assistantThreads.delete(key); // refresh insertion order for LRU eviction
  if (state.assistantThreads.size >= MAX_ASSISTANT_THREADS) {
    const oldest = state.assistantThreads.keys().next().value;
    if (oldest !== undefined) state.assistantThreads.delete(oldest);
  }
  state.assistantThreads.set(key, Date.now());
}

/**
 * Is this thread an assistant split panel?
 *
 * @param state - The adapter's presence state
 * @param channelId - The Slack channel the thread lives in
 * @param threadTs - The thread's root timestamp
 */
export function isAssistantThread(
  state: SlackPresenceState,
  channelId: string,
  threadTs: string | undefined
): boolean {
  if (!threadTs) return false;
  return state.assistantThreads.has(threadKey(channelId, threadTs));
}

// === Pending trigger messages ===

/**
 * Queue a trigger message so a later claim knows what to react to.
 *
 * Nothing is sent to Slack here — queuing is not showing. Entries older than
 * {@link PENDING_REACTION_TTL_MS} are pruned on the way in, so messages that
 * never trigger a turn cannot accumulate.
 *
 * @param state - The adapter's presence state
 * @param channelId - The Slack channel the message arrived in
 * @param messageTs - The message's timestamp
 */
export function queuePendingReaction(
  state: SlackPresenceState,
  channelId: string,
  messageTs: string
): void {
  const now = Date.now();
  const queue = (state.pendingReactions.get(channelId) ?? []).filter(
    (entry) => now - entry.queuedAt <= PENDING_REACTION_TTL_MS
  );
  queue.push({ ts: messageTs, queuedAt: now });
  state.pendingReactions.set(channelId, queue);
}

/**
 * Drop a queued trigger message that will never be answered.
 *
 * @param state - The adapter's presence state
 * @param channelId - The Slack channel the message arrived in
 * @param messageTs - The message's timestamp
 */
export function dropPendingReaction(
  state: SlackPresenceState,
  channelId: string,
  messageTs: string
): void {
  const queue = state.pendingReactions.get(channelId);
  if (!queue) return;
  const idx = queue.findIndex((entry) => entry.ts === messageTs);
  if (idx !== -1) queue.splice(idx, 1);
  if (queue.length === 0) state.pendingReactions.delete(channelId);
}

/**
 * Take the oldest live trigger message for a channel (FIFO).
 *
 * Entries past {@link PENDING_REACTION_TTL_MS} are discarded rather than
 * returned: a message queued five minutes ago and only now reached by a claim
 * is not what this turn is answering, and marking it would put `:eyes:` on a
 * stranger's message. The queue is pruned on the way in too, but a channel that
 * has gone quiet never gets that sweep.
 */
function shiftPendingReaction(state: SlackPresenceState, channelId: string): string | undefined {
  const queue = state.pendingReactions.get(channelId);
  if (!queue) return undefined;
  const now = Date.now();
  let taken: string | undefined;
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (now - entry.queuedAt <= PENDING_REACTION_TTL_MS) {
      taken = entry.ts;
      break;
    }
  }
  if (queue.length === 0) state.pendingReactions.delete(channelId);
  return taken;
}

/**
 * Forget turns nothing can still arrive for.
 *
 * Two kinds: one that settled long enough ago that no straggling event of its
 * own can still turn up, and one that paused on a question nobody ever answered
 * — abandoned, with no claim running behind it and nothing left to resume.
 */
function pruneBindings(state: SlackPresenceState, now: number): void {
  for (const [key, binding] of state.bindings) {
    const settledLongAgo =
      binding.settledAt !== undefined && now - binding.settledAt > PENDING_REACTION_TTL_MS;
    const abandoned = !state.active.has(key) && now - binding.touchedAt > ABANDONED_BINDING_TTL_MS;
    if (settledLongAgo || abandoned) state.bindings.delete(key);
  }
  // Insertion order is close enough to age here, and this only ever fires for a
  // channel churning through a thousand live turns without one of them ending.
  while (state.bindings.size > MAX_BINDINGS) {
    const oldest = state.bindings.keys().next().value;
    if (oldest === undefined) break;
    state.bindings.delete(oldest);
  }
}

// === Slack calls (best-effort, fire-and-forget) ===

/** Add the `:eyes:` reaction — failures are logged, never thrown. */
function addEyes(client: WebClient, channelId: string, messageTs: string, logger?: RelayLogger) {
  void client.reactions
    .add({ channel: channelId, name: PRESENCE_EMOJI, timestamp: messageTs })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already_reacted')) {
        logger?.warn(`presence: failed to add reaction to ${channelId}:${messageTs}: ${msg}`);
      }
    });
}

/** Remove the `:eyes:` reaction — failures are logged, never thrown. */
function removeEyes(client: WebClient, channelId: string, messageTs: string, logger?: RelayLogger) {
  void client.reactions
    .remove({ channel: channelId, name: PRESENCE_EMOJI, timestamp: messageTs })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no_reaction')) {
        logger?.warn(`presence: failed to remove reaction from ${channelId}:${messageTs}: ${msg}`);
      }
    });
}

/** Set (or clear, with an empty string) the assistant thread status. */
function setStatus(
  client: WebClient,
  channelId: string,
  threadTs: string,
  status: string,
  logger?: RelayLogger
) {
  void client.assistant.threads
    .setStatus({ channel_id: channelId, thread_ts: threadTs, status })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(`presence: failed to set status on ${channelId}:${threadTs}: ${msg}`);
    });
}

// === Claim / release ===

/** Put this turn's indicator on screen. Returns whether anything was shown. */
function show(
  client: WebClient,
  channelId: string,
  binding: TurnBinding,
  logger?: RelayLogger
): boolean {
  if (binding.assistant && binding.threadTs) {
    setStatus(
      client,
      channelId,
      binding.threadTs,
      binding.late ? WORKING_LATE_STATUS : WORKING_STATUS,
      logger
    );
    return true;
  }
  if (binding.messageTs) {
    addEyes(client, channelId, binding.messageTs, logger);
    return true;
  }
  return false;
}

/** Take this turn's indicator off screen. */
function hide(
  client: WebClient,
  channelId: string,
  binding: TurnBinding,
  logger?: RelayLogger
): void {
  if (binding.assistant && binding.threadTs) {
    setStatus(client, channelId, binding.threadTs, '', logger);
    return;
  }
  if (binding.messageTs) removeEyes(client, channelId, binding.messageTs, logger);
}

/**
 * Claim presence for a turn, or restate a claim already held.
 *
 * Idempotent by keeping, not by restarting: a turn emits many events, and
 * restarting on each one would re-add the reaction and reset the late timer
 * forever, so a long turn would never be reported as long. Every call restates
 * the inactivity bound and the client to answer on.
 *
 * A turn that resumes after pausing on a question re-shows **its own** binding.
 * A stray event arriving just after a turn settled is refused: it would take a
 * fresh message off the FIFO and mark somebody else's question. Two turns in one
 * Slack thread share a key, so "settled" cannot mean "never again" — it means
 * not within {@link SETTLED_GRACE_MS}, which a straggler is inside of and a
 * person's follow-up question is not.
 *
 * @param ctx - Channel, turn, and client context for the claim
 */
export function claimPresence(ctx: PresenceContext): void {
  const { client, channelId, threadTs, streamKeyTs, typingIndicator, state, logger } = ctx;
  if (typingIndicator === 'none' || !client) return;

  const key = presenceKey(channelId, streamKeyTs);
  const held = state.active.get(key);
  if (held) {
    held.lastEventAt = Date.now();
    held.client = client;
    return;
  }

  const now = Date.now();
  pruneBindings(state, now);
  let binding = state.bindings.get(key);
  if (binding?.settledAt !== undefined) {
    if (Date.now() - binding.settledAt <= SETTLED_GRACE_MS) return; // a straggler, not a turn
    state.bindings.delete(key);
    binding = undefined; // a new question on the same key — a new turn, a new binding
  }

  if (!binding) {
    const assistant = isAssistantThread(state, channelId, threadTs);
    // The queue is drained on every surface, assistant included: leaving this
    // turn's message on it would offset every later turn in the channel by one.
    const queued = shiftPendingReaction(state, channelId);
    binding = {
      threadTs,
      assistant,
      messageTs: assistant ? undefined : queued,
      shown: false,
      late: false,
      settledAt: undefined,
      touchedAt: now,
    };
    state.bindings.set(key, binding);
  }

  binding.touchedAt = now;
  if (!binding.shown) binding.shown = show(client, channelId, binding, logger);

  const entry: ActivePresence = {
    client,
    lastEventAt: now,
    refresh: undefined,
    lateTimer: undefined,
  };
  state.active.set(key, entry);

  if (binding.assistant && binding.threadTs && !binding.late) {
    entry.lateTimer = setTimeout(() => {
      const current = state.active.get(key);
      const live = state.bindings.get(key);
      if (!current || !live || live.late || live.settledAt !== undefined) return;
      live.late = true;
      show(current.client, channelId, live, logger);
    }, PRESENCE_LATE_MS);
    entry.lateTimer.unref?.();
  }

  entry.refresh = setInterval(() => {
    const current = state.active.get(key);
    const live = state.bindings.get(key);
    if (!current || !live) return;
    if (Date.now() - current.lastEventAt > PRESENCE_INACTIVITY_MS) {
      // A stream that has gone dark is over, whatever it failed to say.
      releasePresence({ ...ctx, client: current.client }, 'terminal');
      return;
    }
    // Slack expires an assistant status on its own; restate it while it is true.
    if (live.assistant && live.threadTs) show(current.client, channelId, live, logger);
  }, PRESENCE_REFRESH_MS);
  entry.refresh.unref?.();
}

/**
 * Take a turn's indicator down, and settle its binding if the turn is over.
 *
 * `'paused'` is for the interactions that stop a turn to wait on a person: the
 * indicator comes off, because nobody is working, but the turn keeps the
 * message it is answering so the resume marks that one again.
 *
 * A no-op when nothing is held, so every terminal can call it blindly.
 *
 * @param ctx - Channel, turn, and client context for the claim
 * @param reason - `'terminal'` when the turn is over, `'paused'` when it waits
 */
export function releasePresence(ctx: PresenceContext, reason: 'terminal' | 'paused'): void {
  const { client, channelId, streamKeyTs, state, logger } = ctx;
  const key = presenceKey(channelId, streamKeyTs);

  const entry = state.active.get(key);
  if (entry) {
    state.active.delete(key);
    if (entry.refresh) clearInterval(entry.refresh);
    if (entry.lateTimer) clearTimeout(entry.lateTimer);
  }

  const binding = state.bindings.get(key);
  if (!binding) return;

  const useClient = client ?? entry?.client ?? null;
  if (binding.shown && useClient) {
    hide(useClient, channelId, binding, logger);
    binding.shown = false;
  }
  binding.touchedAt = Date.now();
  if (reason === 'terminal') binding.settledAt = binding.touchedAt;
}

/**
 * Drop every held claim and queued message.
 *
 * Called on adapter stop: the timers must not outlive the adapter. Anything
 * still on screen is taken down best-effort with the client that showed it —
 * an adapter that has already disconnected simply fails those calls, and
 * Slack's own status TTL absorbs the rest.
 *
 * @param state - The adapter's presence state
 * @param client - The client to clean up with, if one is still usable
 * @param logger - Optional logger for the best-effort cleanup calls
 */
export function clearAllPresence(
  state: SlackPresenceState,
  client?: WebClient | null,
  logger?: RelayLogger
): void {
  for (const entry of state.active.values()) {
    if (entry.refresh) clearInterval(entry.refresh);
    if (entry.lateTimer) clearTimeout(entry.lateTimer);
  }
  if (client) {
    for (const [key, binding] of state.bindings) {
      if (!binding.shown) continue;
      // Channel IDs never contain a colon; the stream key after it may.
      const channelId = key.slice(0, key.indexOf(':'));
      hide(client, channelId, binding, logger);
    }
  }
  state.active.clear();
  state.bindings.clear();
  state.pendingReactions.clear();
  state.assistantThreads.clear();
}
