import type { LucideIcon } from 'lucide-react';

/**
 * Placement slots where promos can render.
 *
 * Both are compact sidebar stacks. The `dashboard-main` grid went with the
 * dashboard itself (team-room-home task 1.5); the quiet-state suggestion is its
 * successor on home, and it reads {@link PromoContent.suggestion} rather than
 * taking a placement of its own.
 */
export type PromoPlacement = 'dashboard-sidebar' | 'agent-sidebar';

/** Props passed to dialog content components rendered inside the PromoDialog shell. */
export interface PromoDialogProps {
  onClose: () => void;
}

/** Props for standalone dialog components opened directly by promos. */
export interface PromoOpenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Action types when user clicks the CTA */
export type PromoAction =
  | { type: 'dialog'; component: React.ComponentType<PromoDialogProps> }
  | { type: 'open-dialog'; component: React.ComponentType<PromoOpenDialogProps> }
  | { type: 'navigate'; to: string }
  | { type: 'action'; handler: () => void };

/**
 * A promo written as one sentence, for the quiet state on home.
 *
 * A card can get away with a headline over an icon; a line in a quiet room
 * cannot. So this is separate copy rather than a reuse of
 * {@link PromoContent.title} and {@link PromoContent.ctaLabel}: "Set up" reads
 * as a button and reads as nothing at all mid-sentence.
 *
 * Carrying this copy is also how a promo opts in to the quiet state — there is
 * no second placement to keep in sync, and a promo nobody has written a sentence
 * for simply never speaks there (team-room-home spec D5.3).
 */
export interface QuietSuggestionCopy {
  /** What DorkBot asks, e.g. "Want your agents working while you sleep?". */
  question: string;
  /** What pressing it would do, as a verb phrase, e.g. "Set up a schedule". */
  action: string;
}

/** Content fields — slots pick which subset to render */
export interface PromoContent {
  icon: LucideIcon;
  title: string;
  shortDescription: string;
  ctaLabel: string;
  /** The one-line form, for promos that have one. See {@link QuietSuggestionCopy}. */
  suggestion?: QuietSuggestionCopy;
}

/** Condition context injected into shouldShow */
export interface PromoContext {
  hasAdapter: (name: string) => boolean;
  isTasksEnabled: boolean;
  isMeshEnabled: boolean;
  isRelayEnabled: boolean;
  sessionCount: number;
  agentCount: number;
  /**
   * How many scheduled tasks exist. `0` on an install where nothing is
   * scheduled — which is the only state in which offering to set a schedule up
   * says anything true.
   */
  taskCount: number;
  daysSinceFirstUse: number;
}

/** Full promo definition */
export interface PromoDefinition {
  id: string;
  placements: PromoPlacement[];
  priority: number;
  shouldShow: (ctx: PromoContext) => boolean;
  content: PromoContent;
  action: PromoAction;
}
