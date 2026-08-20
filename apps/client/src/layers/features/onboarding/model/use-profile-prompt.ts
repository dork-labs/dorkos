/**
 * The one-time role prompt's show condition and its ask → saved → gone arc.
 *
 * This used to live inside `ProfilePromptCard`, which self-gated to `null`. That
 * works when a card is mounted unconditionally in a footer; it does not work
 * when the card is one candidate in an arbitration, because the sidebar's bottom
 * slot has to know whether this card wants the slot BEFORE drawing anything
 * (spec `sidebar-simplification` D4).
 *
 * Lifting the phase out is also what keeps the "thanks" beat: saving roles makes
 * the show condition false immediately, and a slot reading only that condition
 * would yank the card out from under the confirmation the person just earned.
 * {@link ProfilePromptApi.visible} carries the linger, so the arbiter holds the
 * slot until the card is genuinely done.
 *
 * @module features/onboarding/model/use-profile-prompt
 */
import { useEffect, useState } from 'react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { useOnboarding } from './use-onboarding';
import { useProfile } from './use-profile';

/** How long the thanks line lingers before the card collapses (ms). */
const SAVED_LINGER_MS = 4000;

/** Where the card is in its ask → saved → gone arc. */
export type ProfilePromptPhase = 'ask' | 'saving' | 'saved' | 'error' | 'done';

/** What {@link useProfilePrompt} hands the card and the slot that arbitrates it. */
export interface ProfilePromptApi {
  /** Whether this card wants the slot. The arbiter reads only this. */
  visible: boolean;
  /** Where the card is in its arc. */
  phase: ProfilePromptPhase;
  /** Roles picked but not yet saved. */
  selected: string[];
  /** Replace the picked roles. */
  setSelected: (roles: string[]) => void;
  /** What the confirm button should say right now. */
  confirmLabel: string;
  /** The save error to show, or `null`. */
  errorMessage: string | null;
  /** Persist the picked roles and move into the thanks beat. */
  save: () => void;
  /** "Don't ask again" — collapses now and records the dismissal. */
  skip: () => void;
}

/**
 * Decide whether the role prompt should be offered, and drive it.
 *
 * Call this ONCE per surface and pass the result to `ProfilePromptCard`. Two
 * calls would be two independent phase machines over the same card.
 */
export function useProfilePrompt(): ProfilePromptApi {
  const { state, isLoading, shouldShowGettingStarted } = useOnboarding();
  const {
    roles,
    rolePromptDismissedAt,
    isLoading: profileLoading,
    saveRoles,
    dismissRolePrompt,
  } = useProfile();

  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<ProfilePromptPhase>('ask');

  // The thanks line lingers briefly, then the card collapses for good. The
  // linger stays at full length under reduced motion: that preference means
  // less animation, not less feedback — collapsing instantly would swallow the
  // only confirmation the person gets.
  useEffect(() => {
    if (phase !== 'saved') return;
    const t = setTimeout(() => setPhase('done'), SAVED_LINGER_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Show condition (spec `user-profile-onboarding` §Existing users) — every
  // clause must hold:
  const onboardingOver = state.completedAt !== null || state.dismissedAt !== null;
  const neverAsked =
    !state.completedSteps.includes('profile') && !state.skippedSteps.includes('profile');
  const qualifies =
    !isLoading &&
    !profileLoading &&
    onboardingOver &&
    roles.length === 0 &&
    neverAsked &&
    rolePromptDismissedAt === null &&
    // Never two cards: when the getting-started card shows, its "Tell DorkBot
    // about your work" row is the single affordance. (The bottom slot enforces
    // this structurally too — one card at a time — but the condition stays,
    // because it is also what stops this card queueing up behind it.)
    !shouldShowGettingStarted;

  let confirmLabel = 'Save';
  if (phase === 'saving') {
    confirmLabel = 'Saving…';
  } else if (phase === 'error') {
    confirmLabel = 'Try again';
  }

  return {
    // The saved thanks line may outlive the show condition — saving roles makes
    // `roles` non-empty — so it holds the slot on its own; everything else
    // obeys the condition strictly.
    visible: phase !== 'done' && (qualifies || phase === 'saved'),
    phase,
    selected,
    setSelected,
    confirmLabel,
    errorMessage: phase === 'error' ? DORKBOT_ONBOARDING_LINES.saveError : null,
    save: () => {
      setPhase('saving');
      saveRoles(selected)
        .then(() => setPhase('saved'))
        .catch(() => setPhase('error'));
    },
    skip: () => {
      setPhase('done');
      void dismissRolePrompt().catch(() => {
        // A failed dismissal write just means the card may return next launch;
        // collapsing now still honors the tap.
      });
    },
  };
}
