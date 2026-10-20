/**
 * The one-time "what should I call you?" card, for installs that finished
 * onboarding before the conversation asked it (DOR-677).
 *
 * The same shape and the same slot as `ProfilePromptCard`: DorkBot's mark on its
 * own row, two lines under it, the form, in the sidebar's bottom slot. Never a modal and never an
 * interruption. Saving or "Don't ask again" each close it for good.
 *
 * **Presentational.** Whether it should be offered, and where it is in its
 * ask → saved → gone arc, is `useIdentityPrompt`, because the bottom slot has
 * to know before it decides which card to draw.
 *
 * @module features/onboarding/ui/IdentityPromptCard
 */
import { motion, useReducedMotion } from 'motion/react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { OperatorIdentityForm } from '@/layers/features/profile';
import type { IdentityPromptApi } from '../model/use-identity-prompt';
import { PromptCardHeader } from './PromptCardHeader';

/** Props for {@link IdentityPromptCard}. */
export interface IdentityPromptCardProps {
  /** The prompt's state and actions, from a single `useIdentityPrompt` call. */
  prompt: IdentityPromptApi;
}

/**
 * The existing-install name-and-handle card.
 *
 * @param props - The prompt state and actions from `useIdentityPrompt`.
 */
export function IdentityPromptCard({ prompt }: IdentityPromptCardProps) {
  const reducedMotion = useReducedMotion();
  const saved = prompt.phase === 'saved';

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label="DorkBot suggestion"
      data-testid="identity-prompt-card"
      className="bg-secondary/60 flex flex-col gap-3 rounded-lg border p-3"
    >
      <PromptCardHeader
        title={
          saved
            ? DORKBOT_ONBOARDING_LINES.identityCardSaved
            : DORKBOT_ONBOARDING_LINES.identityCardPrompt[0]
        }
        description={saved ? undefined : DORKBOT_ONBOARDING_LINES.identityCardPrompt[1]}
        titleIsStatus={saved}
      />
      {!saved && (
        <OperatorIdentityForm
          onSaved={prompt.markSaved}
          onSkip={prompt.skip}
          skipLabel="Don’t ask again"
        />
      )}
    </motion.div>
  );
}
