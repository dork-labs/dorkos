/**
 * The one-time, DorkBot-voiced role prompt for users who onboarded before the
 * profile beat existed (spec `user-profile-onboarding` §Existing users).
 *
 * DorkLogo + two lines + chips, in the sidebar's bottom slot. Never a modal,
 * never an interruption, dismissible in one tap, and shown at most once ever:
 * answering, skipping the onboarding beat, or "Don't ask again" each suppress
 * it permanently (config-backed).
 *
 * The second line and its "Change it in Settings" link answer FB-11 / DOR-1972
 * (a person who answered this had no way to learn where the answer went or how
 * to change it): it stays up through the "saved" phase too, so the moment
 * somebody most wants to know how to fix a wrong answer — right after
 * submitting it — is exactly when the link is on screen. The logo is sized at
 * 40 rather than the 18 it shipped at, per DOR-1973 — at 18 the wordmark's
 * strokes fall under a device pixel and read as a smudge, which is what FB-11
 * photographed.
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
import { useSettingsDeepLink } from '@/layers/shared/model';
import type { ProfilePromptApi } from '../model/use-profile-prompt';
import { ProfileRolePicker } from './ProfileRolePicker';

/** Props for {@link ProfilePromptCard}. */
export interface ProfilePromptCardProps {
  /** The prompt's state and actions, from a single `useProfilePrompt` call. */
  prompt: ProfilePromptApi;
}

/** Width of the logo column (logo + gap), so the picker below lines up under the text. */
const LOGO_COLUMN_CLASS = 'pl-12';

/**
 * The existing-user role prompt card.
 *
 * @param props - The prompt state and actions from `useProfilePrompt`.
 */
export function ProfilePromptCard({ prompt }: ProfilePromptCardProps) {
  const reducedMotion = useReducedMotion();
  const { open: openSettings } = useSettingsDeepLink();
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
          <DorkLogo size={40} className="dark:hidden" />
          <DorkLogo variant="white" size={40} className="hidden dark:block" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm leading-relaxed">
            {phase === 'saved'
              ? DORKBOT_ONBOARDING_LINES.profileSaved
              : DORKBOT_ONBOARDING_LINES.profileCardPrompt[0]}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {DORKBOT_ONBOARDING_LINES.profileCardPrompt[1]}{' '}
            <button
              type="button"
              onClick={() => openSettings('profile')}
              className="focus-visible:ring-ring hover:text-foreground rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
            >
              Change it in Settings
            </button>
            .
          </p>
        </div>
      </div>
      {phase !== 'saved' && (
        <div className={LOGO_COLUMN_CLASS}>
          <ProfileRolePicker
            selected={selected}
            onChange={setSelected}
            onConfirm={prompt.save}
            confirmLabel={confirmLabel}
            onSkip={prompt.skip}
            skipLabel="Don’t ask again"
            busy={phase === 'saving'}
            error={errorMessage}
          />
        </div>
      )}
    </motion.div>
  );
}
