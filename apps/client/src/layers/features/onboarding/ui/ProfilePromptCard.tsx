/**
 * The one-time, DorkBot-voiced role prompt for users who onboarded before the
 * profile beat existed (spec `user-profile-onboarding` §Existing users).
 *
 * Same visual grammar as `TourOfferChips` (DorkLogo + one line + chips), in the
 * sidebar's bottom slot. Never a modal, never an interruption, dismissible in
 * one tap, and shown at most once ever: answering, skipping the onboarding beat,
 * or "Don't ask again" each suppress it permanently (config-backed).
 *
 * **Presentational.** Whether it should be offered at all, and where it is in
 * its ask → saved → gone arc, is `useProfilePrompt` — the bottom slot has to
 * know both before it decides which card to draw, so a card that self-gated to
 * `null` could not take part (spec `sidebar-simplification` D4).
 *
 * @module features/onboarding/ui/ProfilePromptCard
 */
import { motion, useReducedMotion } from 'motion/react';
import { DorkLogo } from '@dorkos/icons/logos';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import type { ProfilePromptApi } from '../model/use-profile-prompt';
import { ProfileRolePicker } from './ProfileRolePicker';

/** Props for {@link ProfilePromptCard}. */
export interface ProfilePromptCardProps {
  /** The prompt's state and actions, from a single `useProfilePrompt` call. */
  prompt: ProfilePromptApi;
}

/**
 * The existing-user role prompt card.
 *
 * @param props - The prompt state and actions from `useProfilePrompt`.
 */
export function ProfilePromptCard({ prompt }: ProfilePromptCardProps) {
  const reducedMotion = useReducedMotion();
  const { phase, selected, setSelected, confirmLabel, errorMessage } = prompt;

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label="DorkBot suggestion"
      data-testid="profile-prompt-card"
      className="bg-secondary/60 flex flex-col gap-2 rounded-lg border p-3"
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
            onConfirm={prompt.save}
            confirmLabel={confirmLabel}
            onSkip={prompt.skip}
            skipLabel="Don't ask again"
            busy={phase === 'saving'}
            error={errorMessage}
          />
        </div>
      )}
    </motion.div>
  );
}
