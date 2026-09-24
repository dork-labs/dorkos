/**
 * Approvals — the cockpit's answer to "an agent wants to do something
 * consequential" (spec `agent-trust` §3.3).
 *
 * Two surfaces show the same queue: the home tab's pinned triage header, and
 * the app header, which carries it on every route through the
 * inbox-bell widget. Both compose the pieces below and render the same
 * {@link ApprovalList}, so the card a person answers is identical wherever they
 * happen to be standing.
 *
 * The card is the request card of spec `agent-permissions` D7: three answers,
 * Allow, Always allow and Deny. Always allow is a per-agent, per-action
 * permission setting, found afterwards on the agent's Permissions page.
 *
 * @module features/approvals
 */
export { ApprovalList } from './ui/ApprovalList';
// The single approval card, exported so the chat transcript can render an
// agent's held destructive capability call inline (DOR-939) — the same card a
// person answers on the home tab, resolving the same approval.
export { ApprovalCard } from './ui/ApprovalCard';
export { ApprovalsUnavailable } from './ui/ApprovalsUnavailable';
// Every surface that lists approvals composes this, so an answered card holds
// its receipt for the same beat on all of them — see the module for the
// disappearance it closes. The two writers (`holdDecidedApproval`,
// `releaseDecidedApproval`) stay off the barrel deliberately, and so do the two
// per-card reads (`useRecordedApprovalDecision`, `useSettlingApprovals`): only
// the card and the list inside this slice ever touch them, and a surface that
// could reach the writers from the public API could pin a card nobody decided.
export {
  APPROVAL_RECEIPT_SETTLE_MS,
  discardSettlingApprovals,
  useApprovalCards,
} from './model/settling-approvals';
// Who asked, drawn once for the whole cockpit. A parked schedule is a different
// object from a capability approval — a `Task`, not a ULID-keyed hold — but the
// question its card answers ("which agent is this, and do we actually know?") is
// the same one, down to the fallback for a request carrying no identity at all.
// Composing this rather than re-deriving it is what keeps one agent the same
// colour and the same badge on both cards.
export { RequestingAgent } from './ui/RequestingAgent';
export { AutonomyAcknowledgementRow } from './ui/AutonomyAcknowledgementRow';
