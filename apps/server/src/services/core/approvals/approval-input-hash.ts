/**
 * The canonical binding hash an approval is scoped to (spec `agent-trust` §3.3).
 *
 * The hash, and the check that only plain JSON is bound, live in
 * `@dorkos/shared/approval-text`, so the session relay on the computer side
 * binds a proof from the web exactly as a card here binds its token (spec
 * `computer-side-starts-alone` §5.7). This is the approvals' own door to them.
 *
 * @module services/core/approvals/approval-input-hash
 */
export {
  ApprovalInputNotBindableError,
  assertBindableInput,
  hashApprovalInput,
} from '@dorkos/shared/approval-text';
