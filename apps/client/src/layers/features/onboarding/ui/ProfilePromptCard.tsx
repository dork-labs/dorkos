/**
 * The one-time, DorkBot-voiced role prompt for users who onboarded before the
 * profile beat existed (spec `user-profile-onboarding` §Existing users).
 *
 * Same visual grammar as `TourOfferChips` (DorkLogo + one line + chips), in the
 * ProgressCard sidebar slot. Never a modal, never an interruption, dismissible
 * in one tap, and shown at most once ever: answering, skipping the onboarding
 * beat, or "Don't ask again" each suppress it permanently (config-backed).
 *
 * @module features/onboarding/ui/ProfilePromptCard
 */
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { DorkLogo } from '@dorkos/icons/logos';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { useOnboarding } from '../model/use-onboarding';
import { useProfile } from '../model/use-profile';
import { ProfileRolePicker } from './ProfileRolePicker';

/** How long the thanks line lingers before the card collapses (ms). */
const SAVED_LINGER_MS = 4000;

/** Where the card is in its ask → saved → gone arc. */
type CardPhase = 'ask' | 'saving' | 'saved' | 'error' | 'done';

/**
 * The existing-user role prompt card. Renders nothing unless every clause of
 * the show condition holds (see the module doc); mounts safely anywhere.
 */
export function ProfilePromptCard() {
  const reducedMotion = useReducedMotion();
  const { state, isLoading, shouldShowGettingStarted } = useOnboarding();
  const {
    roles,
    rolePromptDismissedAt,
    isLoading: profileLoading,
    saveRoles,
    dismissRolePrompt,
  } = useProfile();

  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<CardPhase>('ask');

  // The thanks line lingers briefly, then the card collapses for good.
  useEffect(() => {
    if (phase !== 'saved') return;
    const t = setTimeout(() => setPhase('done'), reducedMotion ? 0 : SAVED_LINGER_MS);
    return () => clearTimeout(t);
  }, [phase, reducedMotion]);

  // Show condition (spec §Existing users) — every clause must hold:
  const onboardingOver = state.completedAt !== null || state.dismissedAt !== null;
  const neverAsked =
    !state.completedSteps.includes('profile') && !state.skippedSteps.includes('profile');
  const show =
    !isLoading &&
    !profileLoading &&
    onboardingOver &&
    roles.length === 0 &&
    neverAsked &&
    rolePromptDismissedAt === null &&
    // Never two cards: when ProgressCard shows, its "Tell DorkBot about your
    // work" row is the single affordance.
    !shouldShowGettingStarted;

  if (phase === 'done') return null;
  // The saved thanks line may outlive the show condition (saving roles makes
  // `roles` non-empty); everything else obeys the condition strictly.
  if (!show && phase !== 'saved') return null;

  const handleSave = () => {
    setPhase('saving');
    saveRoles(selected)
      .then(() => setPhase('saved'))
      .catch(() => setPhase('error'));
  };

  let confirmLabel = 'Save';
  if (phase === 'saving') {
    confirmLabel = 'Saving…';
  } else if (phase === 'error') {
    confirmLabel = 'Try again';
  }

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label="DorkBot suggestion"
      data-testid="profile-prompt-card"
      className="bg-secondary/60 mb-2 flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <DorkLogo size={18} className="dark:hidden" />
          <DorkLogo variant="white" size={18} className="hidden dark:block" />
        </span>
        <p className="text-sm leading-relaxed">
          {phase === 'saved'
            ? DORKBOT_ONBOARDING_LINES.profileSaved
            : DORKBOT_ONBOARDING_LINES.profileCardPrompt}
        </p>
      </div>
      {phase !== 'saved' && (
        <div className="pl-6">
          <ProfileRolePicker
            selected={selected}
            onChange={setSelected}
            onConfirm={handleSave}
            confirmLabel={confirmLabel}
            onSkip={() => {
              setPhase('done');
              void dismissRolePrompt().catch(() => {
                // A failed dismissal write just means the card may return next
                // launch; collapsing now still honors the tap.
              });
            }}
            skipLabel="Don't ask again"
            busy={phase === 'saving'}
            error={phase === 'error' ? DORKBOT_ONBOARDING_LINES.saveError : null}
          />
        </div>
      )}
    </motion.div>
  );
}
