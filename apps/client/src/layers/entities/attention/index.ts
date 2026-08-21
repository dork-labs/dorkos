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
 * `deriveAttentionSignals` and its input shape are how the hook is built rather
 * than what a consumer needs, and the slice's own tests import the pieces they
 * exercise by path. An export with no importer is a promise nobody asked for.
 *
 * @module entities/attention
 */
export { useAttentionSignals, useAttentionSignalsLoading } from './model/use-attention-signals';
// The signal shape, which two layers now name in their own types:
// `features/dashboard-attention` picks the `error` kind out of the list and
// draws it, and `widgets/home` declares that subset as a prop. Both need the
// noun; neither needs the union of kinds, so that stays unexported.
export type { AttentionSignal } from './model/attention-signal';
// **The payload behind a `schedule-approval` signal, never a second answer to
// "what needs me".** Since DOR-1391 a parked schedule IS an attention signal,
// so membership, counts and loading all come from `useAttentionSignals`; this
// stays exported for the one thing a normalized signal cannot do — hand a
// surface the `Task` its approve/reject card is built from. Exactly the split
// `usePendingApprovals` already has beside `permission-prompt`.
export { usePendingScheduleApprovals } from './model/use-pending-schedule-approvals';
export { usePendingApprovals, PENDING_APPROVALS_QUERY_KEY } from './model/use-pending-approvals';
export {
  usePendingInteractions,
  PENDING_INTERACTIONS_QUERY_KEY,
} from './model/use-pending-interactions';
// The Inbox popover's own named derivation of the same three queues above —
// see its module doc for why a dedicated hook replaced three ad hoc calls.
export { useWaitingQueue } from './model/use-waiting-queue';
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
