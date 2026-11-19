/** Server-owned effects of answering an approval, independent of its button label. */
import type { RequestFacts } from '../../../../http/request-facts.js';
import { isFromWifi, NOT_FROM_WIFI } from '../../auth/sessions/wifi-level.js';

/** A classified effect; an unrecognized effect must be confirmed. */
export interface ApprovalDecisionEffect {
  kind: string;
  items?: readonly ApprovalDecisionEffect[];
}

/** Only known lowering actions and inputs fed back to a model are free. */
export function grantsPower(decision: ApprovalDecisionEffect): boolean {
  switch (decision.kind) {
    case 'deny':
    case 'reject':
    case 'revoke':
    case 'dismiss':
    case 'lower':
    case 'model-input':
    case 'plain-choice':
    case 'runtime-tool-once':
    case 'mcp-form-input':
      return false;
    case 'batch':
      return !decision.items?.length || decision.items.some(grantsPower);
    default:
      return true;
  }
}

/** No approval yes on Wi-Fi opens a password sheet or reaches a grant. */
export function refuseApprovalYesFromWifi(facts: RequestFacts) {
  return isFromWifi(facts)
    ? { code: NOT_FROM_WIFI, error: 'Answer at your computer or over Remote Access.' }
    : undefined;
}
