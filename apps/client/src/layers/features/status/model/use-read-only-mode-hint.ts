/**
 * Whether this session should be told, up front, that its mode can read but
 * never change anything and never ask (DOR-2019).
 *
 * ## The dead end this closes
 *
 * A Codex session resting at its read-only sandbox looks like every other
 * session at the dial's "Ask first" stop, and it is not one. Codex's exec mode
 * has no approval channel at all (ADR-0309), so a request to edit a file does
 * not raise a card to answer: the sandbox refuses the write and the model
 * reports that it cannot do it. The person is left reading an apology from an
 * agent that looks broken, with nothing on screen connecting it to the setting
 * they never chose. The same request on Claude Code shows a card.
 *
 * Widening the default was considered and rejected: read-only stays the default
 * on Codex. What changes is that nobody has to discover it by being refused.
 *
 * ## Why it reads the mode's declaration and not the runtime's name
 *
 * `isSilentReadOnly` asks the descriptor two questions the runtime answered
 * itself: can this mode change anything, and can it ask. A runtime that grows an
 * approval channel stops matching the day it declares one, and a future runtime
 * that ships the same dead end gets the same sentence, neither needing an edit
 * here. `supportsToolApproval` is the runtime-wide version of the same fact and
 * is deliberately NOT what this reads: a runtime with no approvals may still
 * have modes that change files, and those are not this dead end.
 *
 * ## Once per session, and only once it has been said
 *
 * It is a fact about a setting, not an event, so it is said once. Two rules, and
 * both are about not spending something that never happened:
 *
 * - **The progress lives per session id, in the chat store, never in a ref.**
 *   `ChatPanel` is not keyed by session, so one instance of this hook serves
 *   every conversation a person switches between; a ref would carry one
 *   session's state into the next. It did: opening a read-only session and then
 *   switching to a second one at a different mode spent the SECOND session's
 *   explanation, which then never appeared for it.
 * - **Leaving the mode spends it only if the card was actually on screen.** The
 *   card is one candidate in an arbitrated slot and can lose it, so qualifying
 *   is not the same as being seen. {@link ReadOnlyModeHint.markShown} is what
 *   the card reports with, and only a `'shown'` session can be spent by leaving.
 *
 * @module features/status/model/use-read-only-mode-hint
 */
import { useCallback, useEffect, useMemo } from 'react';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useReadOnlyHintProgress, useSessionChatStore } from '@/layers/entities/session';
import { isSilentReadOnly } from '@/layers/shared/lib';

/** What {@link useReadOnlyModeHint} hands back. */
export interface ReadOnlyModeHint {
  /**
   * Whether the hint should be drawn right now.
   *
   * Answerable without rendering anything, which is the bottom slot's one rule
   * for its candidates (`shared/ui/bottom-slot`): a card that decides by drawing
   * nothing still wins the slot and silences whatever was behind it.
   */
  eligible: boolean;
  /** The runtime's friendly name for the copy, e.g. `'Codex'`. */
  runtimeLabel: string;
  /**
   * Report that the card reached the screen. The card calls this itself as it
   * mounts; nothing else should, because nothing else knows whether it won the
   * slot it was competing for.
   */
  markShown: () => void;
  /** Never show it again in this session. */
  dismiss: () => void;
}

/**
 * Decide whether this session needs the read-only explanation, and remember the
 * answer for as long as the session is open.
 *
 * @param sessionId - The session being looked at, or a falsy value before one exists.
 * @param runtime - The session's resolved runtime, or nullish while it resolves.
 * @param mode - The session's current permission mode id.
 */
export function useReadOnlyModeHint(
  sessionId: string | null | undefined,
  runtime: string | null | undefined,
  mode: string | undefined
): ReadOnlyModeHint {
  const caps = useCapabilitiesForRuntime(runtime ?? undefined);
  const markShownInStore = useSessionChatStore((s) => s.recordReadOnlyHintShown);
  const spendHint = useSessionChatStore((s) => s.spendReadOnlyHint);
  const progress = useReadOnlyHintProgress(sessionId ?? '');

  const descriptor = caps?.permissionModes.values.find((d) => d.id === mode);
  const silent = descriptor !== undefined && isSilentReadOnly(descriptor);

  // Leaving the mode spends the explanation, so a person who has read it does
  // not get it again on the way back. Only from `'shown'`: a session that
  // qualified while another card held the slot was never told anything, and
  // spending that would lose the sentence entirely.
  useEffect(() => {
    if (silent || !sessionId || progress !== 'shown') return;
    spendHint(sessionId);
  }, [silent, sessionId, progress, spendHint]);

  const markShown = useCallback(() => {
    if (sessionId) markShownInStore(sessionId);
  }, [sessionId, markShownInStore]);

  const dismiss = useCallback(() => {
    if (sessionId) spendHint(sessionId);
  }, [sessionId, spendHint]);

  // Memoized because the caller declares its bottom-slot candidates in a
  // `useMemo` and this is one of its dependencies: a fresh object per render
  // would rebuild that list on every render of the panel.
  return useMemo(
    () => ({
      eligible: Boolean(sessionId) && silent && progress !== 'spent',
      runtimeLabel: runtime ? runtimeDisplayName(runtime) : 'This agent',
      markShown,
      dismiss,
    }),
    [sessionId, silent, progress, runtime, markShown, dismiss]
  );
}
