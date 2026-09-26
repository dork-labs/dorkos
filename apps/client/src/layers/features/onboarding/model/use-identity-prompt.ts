/**
 * Whether to ask the operator what to call them, and the sidebar card's
 * ask → saved → gone arc (DOR-677).
 *
 * **One question, three surfaces, one record.** The first-run conversation,
 * the getting-started card and the sidebar card all read
 * {@link useIdentityQuestion}, and closing the question on any of them —
 * saving, or skipping — writes `profile.identityPromptDismissedAt`, so it is
 * never put twice.
 *
 * **Absence is never consent** (DOR-604). A missing handle is a reason to ASK,
 * never a reason to derive one: nothing here writes a name or a handle. The
 * suggestion a person sees in the field is only shown, and only saved when they
 * press the confirm themselves.
 *
 * @module features/onboarding/model/use-identity-prompt
 */
import { useEffect, useState } from 'react';
import { isOperatorIdentityIncomplete, useTeamRoster } from '@/layers/entities/team';
import { useOnboarding } from './use-onboarding';
import { useProfile } from './use-profile';

/** How long the thanks line lingers before the card collapses (ms). */
const SAVED_LINGER_MS = 4000;

/**
 * Whether the name-and-handle question should be put.
 *
 * - `pending` — the roster or the config has not answered yet. Wait; never
 *   guess in either direction.
 * - `ask` — the operator is missing a name or a handle, and was never asked.
 * - `settled` — nothing to ask: both are set, the question was already closed,
 *   or this install cannot say who the operator is (no roster row), in which
 *   case there is nowhere to save an answer.
 */
export type IdentityQuestion = 'pending' | 'ask' | 'settled';

/**
 * Decide whether the name-and-handle question is still open.
 *
 * A failed roster read settles rather than pends, so a surface waiting on this
 * (the onboarding conversation) is never held up by it.
 */
export function useIdentityQuestion(): IdentityQuestion {
  const roster = useTeamRoster();
  const { identityPromptDismissedAt, isLoading: profileLoading } = useProfile();

  if (profileLoading || roster.isPending) return 'pending';
  if (identityPromptDismissedAt !== null) return 'settled';
  const self = roster.data?.members.find((member) => member.isSelf);
  if (!self) return 'settled';
  return isOperatorIdentityIncomplete(self) ? 'ask' : 'settled';
}

/** Where the sidebar card is in its arc. */
export type IdentityPromptPhase = 'ask' | 'saved' | 'done';

/** What {@link useIdentityPrompt} hands the card and the slot that arbitrates it. */
export interface IdentityPromptApi {
  /** Whether this card wants the slot. The arbiter reads only this. */
  visible: boolean;
  /** Where the card is in its arc. */
  phase: IdentityPromptPhase;
  /** The form saved: record the question as closed and show the thanks line. */
  markSaved: () => void;
  /** "Don't ask again" — collapses now and records the dismissal. */
  skip: () => void;
}

/**
 * Decide whether the one-time sidebar card should be offered, and drive it.
 *
 * For installs that finished onboarding before the conversation asked this.
 * Call it ONCE per surface; two calls would be two phase machines over one
 * card (the same rule `useProfilePrompt` states).
 */
export function useIdentityPrompt(): IdentityPromptApi {
  const { state, isLoading, shouldShowGettingStarted } = useOnboarding();
  const question = useIdentityQuestion();
  const { dismissIdentityPrompt } = useProfile();
  const [phase, setPhase] = useState<IdentityPromptPhase>('ask');

  // Full length under reduced motion too: that preference means less
  // animation, not less feedback.
  useEffect(() => {
    if (phase !== 'saved') return;
    const t = setTimeout(() => setPhase('done'), SAVED_LINGER_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const onboardingOver = state.completedAt !== null || state.dismissedAt !== null;
  const qualifies =
    !isLoading &&
    onboardingOver &&
    question === 'ask' &&
    // Never two cards: while the getting-started card shows, its "Tell DorkBot
    // your name" row is the single place this is asked.
    !shouldShowGettingStarted;

  const recordClosed = () => {
    void dismissIdentityPrompt().catch(() => {
      // A failed write means the card may come back next launch; the person's
      // tap is still honored now.
    });
  };

  return {
    // The thanks line outlives the show condition — the save itself makes the
    // question settled — so it holds the slot on its own.
    visible: phase !== 'done' && (qualifies || phase === 'saved'),
    phase,
    markSaved: () => {
      setPhase('saved');
      recordClosed();
    },
    skip: () => {
      setPhase('done');
      recordClosed();
    },
  };
}
