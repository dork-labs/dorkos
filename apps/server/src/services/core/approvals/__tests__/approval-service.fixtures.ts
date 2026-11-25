/**
 * The two action bindings the approval-service tests share: the action a
 * person is asked about, and another one a leaked token must never reach.
 */
import { hashApprovalInput } from '../approval-input-hash.js';

/** A binding for a plausible destructive action. */
export const BINDING: { capabilityId: string; inputHash: string } = {
  capabilityId: 'marketplace.uninstall',
  inputHash: hashApprovalInput({ name: 'sentry-monitor' }),
};

/** The other action a leaked token must never reach. */
export const OTHER_BINDING: { capabilityId: string; inputHash: string } = {
  capabilityId: 'marketplace.uninstall',
  inputHash: hashApprovalInput({ name: 'something-else' }),
};
