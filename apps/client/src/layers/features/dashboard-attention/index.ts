/**
 * Dashboard attention feature — conditional attention zone for items needing user action.
 * Renders zero DOM when empty. Animates in/out with AnimatePresence.
 *
 * @module features/dashboard-attention
 */
export { NeedsAttentionSection } from './ui/NeedsAttentionSection';
export { useAttentionItems } from './model/use-attention-items';
export type { AttentionItem } from './model/use-attention-items';
