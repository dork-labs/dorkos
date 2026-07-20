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
 * Failure: a REJECTED trigger started no turn, so the guards un-latch for
 * exactly ONE retry (the module-level `failedKickoffs` set bounds it). When the
 * retry is also spent, the record is marked `greetingFailed`, which the empty
 * session renders as an honest, actionable line ("{name} couldn't say hello
 * just now — send a message to get started.") — never a dead Retry button (the
 * trigger path raises no error banner for a kickoff: the person typed nothing).
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
import type { ChatStatus } from '../chat-types';

/** Session ids whose kickoff has already been triggered this page session. */
const firedKickoffs = new Set<string>();

/** Session ids whose kickoff trigger already failed once — no further retries. */
const failedKickoffs = new Set<string>();

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
  /** How many messages are rendered — the kickoff only fires into an empty session. */
  messageCount: number;
  /** Trigger the agent's first turn (from `useSessionSubmit`). Rejects when the trigger POST fails. */
  submitKickoff: (content: string) => Promise<void>;
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
  messageCount,
  submitKickoff,
}: UseAutoKickoffParams): void {
  const record = useAgentBirthRecord(sessionId);

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
    submitKickoff(record.kickoffMessage).catch((err: unknown) => {
      console.warn('[chat] kickoff trigger failed for newborn session', sessionId, err);
      // A rejected trigger started no turn — safe to un-latch. Bounded to ONE
      // retry: the first failure re-arms the guards (the store update re-runs
      // this effect); a repeat failure stays latched so a persistent outage
      // cannot loop. The empty+idle gate above still refuses if a turn somehow
      // started in the meantime.
      if (!failedKickoffs.has(sessionId)) {
        failedKickoffs.add(sessionId);
        firedKickoffs.delete(sessionId);
        useAgentBirthStore.getState().resetFired(sessionId);
      } else {
        // The retry is spent — the agent never got to say hello. Mark it so the
        // session shows an honest, actionable line instead of a blank screen or
        // a dead Retry button (the trigger path deliberately raises no error
        // banner for a kickoff — the person typed nothing to retry).
        useAgentBirthStore.getState().markGreetingFailed(sessionId);
      }
    });
  }, [sessionId, cwd, record, status, messageCount, submitKickoff]);
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
}
