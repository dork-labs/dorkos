/**
 * Approvals — the cockpit's answer to "an agent wants to do something
 * consequential" (spec `agent-trust` §3.3).
 *
 * The dashboard mounts the section; everything else in the slice is its
 * internals, and joins this barrel when a second surface needs it.
 *
 * @module features/approvals
 */
export { PendingApprovalsSection } from './ui/PendingApprovalsSection';
