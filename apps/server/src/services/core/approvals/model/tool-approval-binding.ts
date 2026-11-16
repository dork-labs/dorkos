/** Stable identity for one runtime approval, independent of its countdown. */
import type { PendingInteractionDTO } from '@dorkos/shared/schemas';
import { hashApprovalInput } from '../approval-input-hash.js';
import { requestCodeForHash } from '../../auth/step-up/request-code.js';

/** The complete tool request a person may approve. */
export type PendingToolApproval = Extract<PendingInteractionDTO, { type: 'approval' }>;

/** Hash the full disclosure with its stable projector identity; a rename does not change the code. */
export function toolApprovalHash(streamGeneration: string, approval: PendingToolApproval): string {
  const {
    remainingMs: _remaining,
    timeoutMs: _timeout,
    parked: _parked,
    requestCode: _code,
    ...request
  } = approval;
  return hashApprovalInput({ t: 'dorkos.tool-approval.step-up.v1', streamGeneration, request });
}

/** Add the same display-only code to live and recovered tool approval cards. */
export function withToolApprovalCode(
  streamGeneration: string,
  interaction: PendingInteractionDTO
): PendingInteractionDTO {
  return interaction.type === 'approval'
    ? {
        ...interaction,
        requestCode: requestCodeForHash(toolApprovalHash(streamGeneration, interaction)),
      }
    : interaction;
}
