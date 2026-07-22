/**
 * Auto-first-turn: fire a newborn agent's opening greeting exactly once (M4).
 *
 * When an agent is created, the create flow records a birth for its first
 * session (see `agent-birth-store`) carrying a fenced kickoff instruction. This
 * hook watches the active session and, the first time it sees a brand-new
 * session with a pending birth, triggers the agent's opening turn — so the agent
 * speaks first, without the person typing anything.
 *
 * Fire-EXACTLY-once is guarded three ways, so a remount or a create-on-first-
 * message rekey never re-triggers:
 * 1. A module-level fired set (synchronous, survives store churn and StrictMode
 *    double-invoke — the reliable guard within a page session).
 * 2. The record's own `fired` latch (migrates across the rekey with the record).
 * 3. The "only into an empty, idle session" gate — after the trigger the session
 *    is streaming, so the rekeyed remount is refused by state alone.
 *
 * Failure comes two ways, both surfacing the SAME honest line ("{name} couldn't
 * say hello just now — send a message to get started.") on the empty session —
 * never a dead Retry button (the trigger path raises no error banner for a
 * kickoff: the person typed nothing):
 * 1. The TRIGGER is rejected — the POST failed, so no turn started. The guards
 *    un-latch for exactly ONE retry (the module-level `failedKickoffs` set bounds
 *    it); when that retry is also spent, the record is marked `greetingFailed`.
 * 2. The turn DIES MID-STREAM — the POST 202'd and the turn started (streaming)
 *    but ended or errored before any assistant text. The `fired` latch stays set,
 *    so path 1's retry never runs; a second effect watches the kickoff turn's
 *    lifecycle and, when a kickoff that was observed streaming settles back to an
 *    EMPTY session, marks `greetingFailed`. "Empty" is CONTENT-AWARE (text/tool
 *    output, not error parts): a typed error renders an inline error part that
 *    briefly makes the list non-empty, but claude-code never persists it, so the
 *    turn_end reload drops it — treating that blip as landed content would clear
 *    the marker and swallow the honest line. The flip also waits for hydration
 *    (`streamReadyCursor`) so a session revisited before its snapshot lands is
 *    never falsely flipped. Scoped to the kickoff turn alone: the moment real
 *    content lands the session stays non-empty, so a LATER failed turn can't flip
 *    it.
 *
 * A trigger that was accepted never un-latches; the empty+idle gate
 * independently prevents a double-greet even if it did.
 *
 * A full page reload clears both the module sets and the (ephemeral) birth
 * store, but by then the turn already happened server-side and replays from the
 * transcript — there is nothing left to fire.
 *
 * @module features/chat/model/kickoff/use-auto-kickoff
 */
import { useEffect } from 'react';
import { useAgentBirthRecord, useAgentBirthStore } from '@/layers/shared/model';
import type { ChatMessage, ChatStatus } from '../chat-types';

/** Session ids whose kickoff has already been triggered this page session. */
const firedKickoffs = new Set<string>();

/** Session ids whose kickoff trigger already failed once — no further retries. */
const failedKickoffs = new Set<string>();

/**
 * Session ids whose kickoff turn was observed actually streaming. The
 * mid-stream failure detector only treats a settle-to-empty as a dead greeting
 * once the turn was seen live — so the brief window between firing and the first
 * turn frame is never mistaken for a failure.
 */
const kickoffStreamStarted = new Set<string>();

/**
 * Whether a rendered message carries GENUINE assistant output the person would
 * read as a greeting — text or tool output. An error-only bubble does NOT count:
 * a typed mid-stream error folds into a rendered error part (so the message list
 * transiently has one entry), but for claude-code that error is never persisted
 * to JSONL, so the turn_end history reload drops it and the list returns to
 * empty. Counting it as "content landed" would clear the mid-stream marker and
 * suppress the honest line the reload should surface — so the "landed" signal is
 * content-aware, not a raw message count.
 *
 * @param message - A rendered chat message.
 */
function hasGreetableContent(message: ChatMessage): boolean {
  if (message.role === 'user') return true;
  if (message.content.trim().length > 0) return true;
  if ((message.toolCalls?.length ?? 0) > 0) return true;
  return message.parts.some((part) => part.type === 'tool_call');
}

/** Inputs for {@link useAutoKickoff}. */
export interface UseAutoKickoffParams {
  /** The active session id, or null. */
  sessionId: string | null;
  /**
   * The session's working directory. Lets a fresh session CLAIM an unfired
   * birth registered for its agent directory but never visited under its
   * original id — the create-without-navigate path (e.g. onboarding advances
   * instead of opening a session; the hello then lands on the agent's real
   * first session).
   */
  cwd: string | null;
  /** The coarse rendered status — the kickoff only fires into an `idle` session. */
  status: ChatStatus;
  /**
   * The rendered message list. The kickoff only fires into an EMPTY session, and
   * the mid-stream failure detector reads it content-aware ({@link
   * hasGreetableContent}) so a transient error-only render is not mistaken for a
   * landed greeting.
   */
  messages: ChatMessage[];
  /**
   * Whether the durable stream snapshot has landed for this session
   * (`streamReadyCursor !== null`). Gates the mid-stream flip so a session
   * revisited BEFORE it rehydrates — momentarily empty though its greeting
   * succeeded server-side — is never marked failed; the flip waits until the
   * emptiness is confirmed real.
   */
  hydrated: boolean;
  /** Trigger the agent's first turn (from `useSessionSubmit`). Rejects when the trigger POST fails. */
  submitKickoff: (content: string) => Promise<void>;
  /**
   * Send a message through the NORMAL submission path (from `useSessionSubmit`),
   * which renders the user's own bubble. Used for `kind: 'first-message'` birth
   * records — the onboarding dissolve, where the opening turn is the user's typed
   * words, not the agent saying hello first (ADR 260722-111316).
   */
  submitContent: (content: string) => Promise<void>;
}

/**
 * Fire the newborn agent's opening turn once for a session that has a pending
 * birth record. No-op for every ordinary session.
 *
 * @param params - The active session, its state, and the kickoff trigger.
 */
export function useAutoKickoff({
  sessionId,
  cwd,
  status,
  messages,
  hydrated,
  submitKickoff,
  submitContent,
}: UseAutoKickoffParams): void {
  const record = useAgentBirthRecord(sessionId);
  const messageCount = messages.length;
  const hasLandedContent = messages.some(hasGreetableContent);

  useEffect(() => {
    if (!sessionId) return;
    if (!record) {
      // No birth under this session id — a fresh, idle, empty session may
      // claim an unfired birth registered for its directory (the create path
      // that never navigated). The claim re-keys the record to this session;
      // the store update re-runs this effect, which then fires normally.
      if (cwd && messageCount === 0 && status === 'idle') {
        useAgentBirthStore.getState().claimByPath(cwd, sessionId);
      }
      return;
    }
    if (record.fired || firedKickoffs.has(sessionId)) return;
    // Only open a truly fresh session. A session that already has content or a
    // turn in flight is never one we may inject an opening into.
    if (messageCount > 0 || status !== 'idle') return;

    firedKickoffs.add(sessionId);
    useAgentBirthStore.getState().markFired(sessionId);
    // A `first-message` record carries the user's own typed words (onboarding
    // dissolve): send it through the normal path so the user's bubble renders as
    // theirs. Every other record is the agent-says-hello-first kickoff.
    const isFirstMessage = record.kind === 'first-message';
    const submit = isFirstMessage ? submitContent : submitKickoff;
    submit(record.kickoffMessage).catch((err: unknown) => {
      console.warn('[chat] first-turn trigger failed for newborn session', sessionId, err);
      // A rejected trigger started no turn — safe to un-latch. Bounded to ONE
      // retry: the first failure re-arms the guards (the store update re-runs
      // this effect); a repeat failure stays latched so a persistent outage
      // cannot loop. The empty+idle gate above still refuses if a turn somehow
      // started in the meantime.
      if (!failedKickoffs.has(sessionId)) {
        failedKickoffs.add(sessionId);
        firedKickoffs.delete(sessionId);
        useAgentBirthStore.getState().resetFired(sessionId);
      } else if (!isFirstMessage) {
        // The retry is spent — the agent never got to say hello. Mark it so the
        // session shows an honest, actionable line instead of a blank screen or
        // a dead Retry button (the trigger path deliberately raises no error
        // banner for a kickoff — the person typed nothing to retry). A
        // `first-message` failure is a normal failed user send: the standard
        // submission path already surfaces its own error affordance, so it never
        // shows the greeting-failed line.
        useAgentBirthStore.getState().markGreetingFailed(sessionId);
      }
    });
  }, [sessionId, cwd, record, status, messageCount, submitKickoff, submitContent]);

  // Honest mid-stream failure: a kickoff whose trigger was ACCEPTED (202) can
  // still die — the turn starts, then ends or errors before any assistant text.
  // The `fired` latch stays set, so the rejection retry above never runs. Watch
  // the kickoff turn's lifecycle and, when a turn that was observed streaming
  // settles back to an EMPTY idle/error session, surface the same honest line so
  // the birth moment never falls back to the generic "Start a conversation" copy.
  useEffect(() => {
    if (!sessionId || !record) return;
    // A `first-message` record is a real user turn, not the agent's greeting: a
    // turn that produces no assistant text is an ordinary (if quiet) session, not
    // a failed hello, so the mid-stream greeting-failed detector never applies.
    if (record.kind === 'first-message') return;
    // Only a session whose kickoff was actually triggered — never an ordinary
    // one, and never before the fire effect above has run.
    if (!record.fired && !firedKickoffs.has(sessionId)) return;
    if (record.greetingFailed) return;
    // GENUINE content (text or tool output) means the greeting landed — the turn
    // produced output, so the kickoff succeeded. Content-aware on purpose: a
    // transient error-only render does NOT clear the marker, so the honest flip
    // still fires after the turn_end reload drops that unpersisted error. This is
    // also what scopes the detector to the kickoff turn alone — once real content
    // lands it stays, so a LATER failed turn can never re-enter.
    if (hasLandedContent) {
      kickoffStreamStarted.delete(sessionId);
      return;
    }
    if (status === 'streaming') {
      // The kickoff turn is live. Remember it actually started so a subsequent
      // settle to an empty idle/error is a genuine mid-stream death — not the
      // brief window between firing and the first turn frame arriving.
      kickoffStreamStarted.add(sessionId);
      return;
    }
    // `idle` or `error` with no genuine content. If the kickoff turn had started
    // streaming, it ended or errored before emitting any assistant text — the
    // agent never got to say hello. Wait for hydration first: a session revisited
    // before its snapshot lands is momentarily empty though its greeting may have
    // succeeded, so the flip only fires once the emptiness is confirmed real.
    if (hydrated && kickoffStreamStarted.has(sessionId)) {
      // Drop the marker so a settled failed birth leaves no lingering entry.
      kickoffStreamStarted.delete(sessionId);
      useAgentBirthStore.getState().markGreetingFailed(sessionId);
    }
  }, [sessionId, record, status, hasLandedContent, hydrated]);
}

/**
 * Test-only reset of the module-level guard sets. Never called in production —
 * both sets are intentionally page-lifetime state.
 *
 * @internal
 */
export function __resetFiredKickoffsForTest(): void {
  firedKickoffs.clear();
  failedKickoffs.clear();
  kickoffStreamStarted.clear();
}
