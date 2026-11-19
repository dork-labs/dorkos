/** What an agent receives while its exact request waits for a person. */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { ApprovalRequiredReason, ApprovalRetryChannel } from './tier-enforcement.js';

/** The pending request and the exact retry an agent may make after a person answers. */
export interface ApprovalRequiredPayload {
  /** Discriminator. Always `approval_required`. */
  status: 'approval_required';
  /** The capability that did NOT run. */
  capabilityId: string;
  /** Its human-facing title, as the operator's card shows it. */
  capabilityTitle: string;
  /** Its permission tier, from the registry — never from the requester. */
  tier: CapabilityTier;
  /** The approval a person will decide. Safe to show or log. */
  approvalId: string;
  /** Display-only code matching the person's card. */
  requestCode?: string;
  /** The one-time token to present on the retry. Inert until someone grants it. */
  approvalToken: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
  /** Why the call is not running yet. */
  reason: ApprovalRequiredReason;
  /** One plain sentence a model (or a person reading a log) can act on. */
  message: string;
  /** Exactly how to retry once a person has approved. */
  retry: {
    /** Whether the token rides an MCP tool argument or an HTTP header. */
    channel: ApprovalRetryChannel;
    /** The exact argument or header name to put the token in. */
    field: string;
    /** Step-by-step retry instructions, written for the model. */
    instructions: string;
  };
}
