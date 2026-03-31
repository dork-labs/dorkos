import type { LucideIcon } from 'lucide-react';

/** Placement slots where promos can render */
export type PromoPlacement = 'dashboard-main' | 'dashboard-sidebar' | 'agent-sidebar';

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

/** Content fields — slots pick which subset to render */
export interface PromoContent {
  icon: LucideIcon;
  title: string;
  shortDescription: string;
  ctaLabel: string;
}

/** Condition context injected into shouldShow */
export interface PromoContext {
  hasAdapter: (name: string) => boolean;
  isTasksEnabled: boolean;
  isMeshEnabled: boolean;
  isRelayEnabled: boolean;
  sessionCount: number;
  agentCount: number;
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
