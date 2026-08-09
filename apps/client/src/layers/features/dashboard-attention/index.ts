/**
 * Attention — what is wrong and still wrong: stalled sessions, failed runs,
 * dead letters, offline agents.
 *
 * The rows and their detail sheets; the group that holds them is the home tab's
 * pinned triage header, which composes this slice rather than owning its
 * heuristics.
 *
 * @module features/dashboard-attention
 */
export { AttentionItemRow } from './ui/AttentionItem';
export { useAttentionItems } from './model/use-attention-items';
export type { AttentionItem, AttentionState } from './model/use-attention-items';
export { DeadLetterDetailSheet } from './ui/DeadLetterDetailSheet';
export { FailedRunDetailSheet } from './ui/FailedRunDetailSheet';
export { OfflineAgentDetailSheet } from './ui/OfflineAgentDetailSheet';
