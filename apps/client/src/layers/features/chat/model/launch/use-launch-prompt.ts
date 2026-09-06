/**
 * The `?prompt=` / `?send=1` launch deep link — words a link carries into a
 * conversation, consumed exactly once.
 *
 * Two surfaces already want this and more will: "Run this with…" re-runs a
 * prompt into a fresh session on another runtime, and a docs page or a CLI can
 * hand somebody a link that opens DorkOS with the question already written. The
 * link's job ends the moment the words are in the composer (or sent); after that
 * it is history, and history that keeps acting is the failure mode here.
 *
 * ## What "once" has to survive
 *
 * A React effect fires again on every dependency change, a component remounts on
 * every back-navigation, and StrictMode invokes effects twice on purpose. None
 * of those is a new launch. So the latches are MODULE-level sets keyed by
 * session + prompt (the same shape `use-auto-kickoff` uses, for the same
 * reason): they are synchronous, they survive a remount, and they cannot be
 * reset by a re-render.
 *
 * The URL is the other half of that, and it is spent on EVERY outcome — not only
 * the ones where the words land. A launch that can never apply (a composer
 * somebody has typed in, a conversation that already has history) is decided,
 * not deferred: it drops the params too. Deferring was a real defect rather than
 * an untidiness — `?prompt=…&send=1` that nothing consumed simply stayed in the
 * address, still armed, and the next thing to spread the search params forward
 * carried it into a session where it DID apply. `/clear` is exactly that: it
 * mints a fresh session id, which is empty by construction, and the stale prompt
 * typed and sent itself into somebody's new conversation. (`setSessionId` now
 * also drops both params explicitly, so the two halves fail independently.)
 *
 * ## What a launch must never do
 *
 * **Overwrite typing.** A seed lands only into an EMPTY composer. Somebody who
 * started typing while the route settled keeps their words.
 *
 * **Enter an ongoing conversation.** A seed lands only into a conversation with
 * no messages. This is what makes the deep link safe for new conversations only:
 * the loader already refuses to carry a prompt onto a session it RESUMED
 * (`sessionRouteLoader`), and this is the guard that holds even when the URL was
 * typed by hand with a `session` id already in it.
 *
 * **Act before the history is known.** Nothing at all happens until the durable
 * stream's snapshot has landed (`hydrated`) — not the send, and not the pre-fill
 * either. Before it, "this conversation has no messages" is not a fact, it is a
 * loading state that looks exactly like one, and BOTH branches read it: seeding
 * on it types into a live chat the person is watching, and sending on it drops a
 * stray turn into their existing conversation. So that window is the one place
 * this hook decides nothing.
 *
 * **Take a parallel path to the runtime.** The send calls the SAME `handleSubmit`
 * the composer's Enter key calls — which is why it waits for the seeded text to
 * land in the composer state first, rather than pushing content down a second
 * route. Everything create-on-first-message needs (subscribe-first, the id
 * rekey, the optimistic bubble, the lock) is on that path and nowhere else.
 *
 * ## The bound this does not hold, stated rather than implied
 *
 * The latches are per-JS-context, so the SAME `send=1` link opened in two tabs
 * at once fires in both. What contains it is the server's session write-lock:
 * both tabs address one session id, the first trigger takes the lock and the
 * second gets a `409`, which the composer already surfaces as a busy session
 * with the text restored. A cross-tab latch would need `localStorage` (per-tab
 * `sessionStorage` cannot see the other tab at all), and that trades this
 * bounded, already-handled case for an unbounded one: a permanent record that
 * would refuse a link the person deliberately re-opens later. Left as is
 * deliberately.
 *
 * @module features/chat/model/launch/use-launch-prompt
 */
import { useEffect } from 'react';
import type { ChatStatus } from '../chat-types';

/** `session + prompt` pairs whose composer has already been seeded this page session. */
const seededLaunches = new Set<string>();

/** `session + prompt` pairs whose auto-send has already fired this page session. */
const sentLaunches = new Set<string>();

/**
 * The latch key.
 *
 * The separator is written as the `\u0000` ESCAPE rather than as a literal NUL
 * byte: a literal one makes git treat this whole source file as binary, which
 * silently costs every future diff, blame and review of it. NUL is still the
 * right separator — it cannot appear in a session id or in a URL-decoded
 * prompt, so no two pairs can collide by concatenation.
 */
function launchKey(sessionId: string, prompt: string): string {
  return `${sessionId}\u0000${prompt}`;
}

/**
 * Clear both launch latches.
 *
 * @internal Test-only: the sets are module state deliberately, so a suite that
 * exercises two launches in a row has to reset them explicitly.
 */
export function __resetLaunchPromptsForTest(): void {
  seededLaunches.clear();
  sentLaunches.clear();
}

/** Inputs for {@link useLaunchPrompt}. */
export interface UseLaunchPromptParams {
  /** The active session id, or null before one is resolved. */
  sessionId: string | null;
  /** The `?prompt=` text, already URL-decoded by the router. */
  prompt?: string;
  /** The `?send=1` flag: start the turn instead of only pre-filling. */
  autoSend: boolean;
  /** The composer's current text — a seed lands only when this is empty. */
  input: string;
  /** Composer setter (the same one the composer itself writes through). */
  setInput: (value: string) => void;
  /** How many messages the conversation already has; a launch enters only an empty one. */
  messageCount: number;
  /**
   * Whether the durable stream's snapshot has landed (`streamReadyCursor !== null`).
   *
   * Gates EVERYTHING, pre-fill included. An un-hydrated conversation is
   * indistinguishable from an empty one, and both branches act on that
   * distinction — so until it lands, this hook does nothing and decides nothing.
   */
  hydrated: boolean;
  /** The rendered chat status — an auto-send never interrupts a running turn. */
  status: ChatStatus;
  /**
   * Whether a transient caller-owned prerequisite prevents submission right now.
   * The launch stays armed and retries when the prerequisite settles.
   */
  submitBlocked?: boolean;
  /** The composer's own submit (`handleSubmit`), which reads the composer text. */
  submit: () => Promise<void> | void;
  /** Called when the composer has just been seeded (the caller focuses it). */
  onSeeded?: () => void;
  /** Called once the link is spent — the caller drops `prompt`/`send` from the URL. */
  onConsumed?: () => void;
}

/**
 * Apply a launch deep link to the active session: pre-fill the composer, and
 * with `send=1` start the turn — each at most once per session and prompt.
 *
 * @param params - The launch params, the composer's state, and the submit seam.
 */
export function useLaunchPrompt({
  sessionId,
  prompt,
  autoSend,
  input,
  setInput,
  messageCount,
  hydrated,
  status,
  submitBlocked = false,
  submit,
  onSeeded,
  onConsumed,
}: UseLaunchPromptParams): void {
  // A prompt of only whitespace is a malformed link, not an empty instruction:
  // seeding it would clear nothing and `handleSubmit` would refuse it anyway,
  // leaving the latches spent on a launch that never happened.
  const seed = prompt?.trim() ? prompt : undefined;
  const key = sessionId && seed ? launchKey(sessionId, seed) : null;

  // ── Decide, once: seed it or spend it ─────────────────────────────────────
  useEffect(() => {
    if (!key || !seed) return;
    if (seededLaunches.has(key)) return;
    // NOT YET DECIDABLE. Before the snapshot lands, a conversation looks empty
    // whether it is empty or merely unloaded — so this window is the one place
    // where "no messages" is not evidence of anything, and neither branch below
    // may be taken on it.
    if (!hydrated) return;

    seededLaunches.add(key);

    // MOOT, and that is a decision rather than a wait. A dirty composer or a
    // conversation with history means this link can never apply — messages only
    // accumulate and typed text is the person's — so the link is SPENT here.
    // Leaving it unspent is how `?send=1` used to survive its own launch: still
    // in the address, still armed, and carried forward by the next thing that
    // spread the search params (a `/clear` mints a fresh session, which IS empty,
    // and the stale prompt typed and sent itself into it).
    if (input.length > 0 || messageCount > 0) {
      sentLaunches.add(key);
      onConsumed?.();
      return;
    }

    setInput(seed);
    onSeeded?.();
    // A prefill-only link is spent right here. One with `send=1` is not — the
    // send effect below still needs the prompt, so it spends the link itself.
    if (!autoSend) onConsumed?.();
  }, [key, seed, autoSend, input, hydrated, messageCount, setInput, onSeeded, onConsumed]);

  // ── Auto-send ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!key || !seed || !autoSend) return;
    if (sentLaunches.has(key)) return;
    if (!seededLaunches.has(key)) return;
    // The seeded text has to be IN the composer before submitting, because
    // `submit` is the composer's own handler and reads it from there. This is
    // also what serializes the two effects: the send waits for the parent's
    // state update, so it can never race the pre-fill.
    if (input !== seed) return;
    if (!hydrated || messageCount > 0 || status === 'streaming' || submitBlocked) return;

    sentLaunches.add(key);
    // Spend the URL BEFORE the turn starts. The first message can re-key the
    // session id and rewrite the address; dropping the params first means that
    // rewrite cannot carry a live `send=1` forward with it.
    onConsumed?.();
    void submit();
  }, [
    key,
    seed,
    autoSend,
    input,
    hydrated,
    messageCount,
    status,
    submitBlocked,
    submit,
    onConsumed,
  ]);
}
