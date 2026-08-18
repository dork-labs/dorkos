/**
 * Attention entity — the one normalized answer to "what needs me right now?"
 * (spec `sidebar-now-today-library` §A1).
 *
 * Two surfaces ask it: the sidebar's Heads up zone and the home surface's triage
 * header. Their sources used to live in two sibling feature slices, which meant
 * neither surface could read the other's answer and the sidebar could read
 * neither. The normalization lives here so both read the same list, and the
 * feature slices keep their own surfaces — the cards, the rows, the sheets.
 *
 * What is **not** here: rendering. A signal carries facts (`kind`, `since`,
 * `deepLink`), never an icon, a colour or a relative time.
 *
 * The barrel is deliberately narrow — values with a caller, and nothing else.
 * `deriveAttentionSignals`, its input shape and the signal type itself are how
 * the hook is built rather than what a consumer needs: the two callers read
 * `useAttentionSignals()`'s return type through inference, and the slice's own
 * tests import the pieces they exercise by path. An export with no importer is
 * a promise nobody asked for.
 *
 * @module entities/attention
 */
export { dismissIdleNudge, useIdleNudgeStore } from './model/idle-nudge-store';
export { useAttentionSignals } from './model/use-attention-signals';
export { usePendingApprovals, PENDING_APPROVALS_QUERY_KEY } from './model/use-pending-approvals';
export {
  usePendingInteractions,
  PENDING_INTERACTIONS_QUERY_KEY,
} from './model/use-pending-interactions';
// The half-sentence that follows an agent's name ("wants to edit standup.md").
// Exported because `features/ask` builds the card's headline from it, and one
// phrasing is the point.
export { describeInteraction, agentNameFromCwd } from './model/describe-interaction';
export { useAskAgentNames } from './model/use-ask-agent-names';
export {
  recordAskReceipt,
  forgetAskReceipt,
  useAskReceipt,
  settleAsk,
  useSettlingAsks,
  clearAskReceipts,
  type AskReceipt,
} from './model/ask-receipt-store';
