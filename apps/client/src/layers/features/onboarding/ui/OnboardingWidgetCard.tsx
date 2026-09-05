/**
 * A card wrapper for the onboarding conversation's interactive widgets.
 *
 * The personality picker and discovery beat are real controls, not more chat
 * text, so they sit inside a bordered card that separates them from DorkBot's
 * message bubbles above. Modeled on the inline MCP App block's treatment.
 *
 * @module features/onboarding/ui/OnboardingWidgetCard
 */
import type { ReactNode } from 'react';
import { Card } from '@/layers/shared/ui';

/** Props for {@link OnboardingWidgetCard}. */
export interface OnboardingWidgetCardProps {
  /** The interactive widget to frame. */
  children: ReactNode;
}

/**
 * Frame an onboarding widget so it reads as an interactive card.
 *
 * @param props - The widget to render inside the card.
 */
export function OnboardingWidgetCard({ children }: OnboardingWidgetCardProps) {
  return (
    <Card gap="none" className="bg-card/50">
      {children}
    </Card>
  );
}
