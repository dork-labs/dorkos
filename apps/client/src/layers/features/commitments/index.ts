/**
 * Commitments as a person sees them (spec `heartbeats` §12): every agent's
 * promises, open first with overdue ones marked, and the controls to mark one
 * kept, drop it, or add one for an agent.
 *
 * @module features/commitments
 */
export { CommitmentList, type CommitmentListProps } from './ui/CommitmentList';
export { CommitmentRow, type CommitmentRowProps } from './ui/CommitmentRow';
export { AddCommitmentForm, type AddCommitmentFormProps } from './ui/AddCommitmentForm';
export { dueLabel, rosterNameLookup, splitCommitments, toLabel } from './lib/commitment-labels';
