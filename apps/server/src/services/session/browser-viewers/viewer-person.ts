import type { RequestFacts } from '../../../http/request-facts.js';
import { presentsProgramCredential } from '../../../lib/caller-authority.js';
import { presentsAgentIdentity } from '../../../middleware/agent-identity.js';
import { APPROVAL_TOKEN_HEADER } from '../../core/capabilities/approval-wording.js';
import type { ViewerPrincipal } from './viewer-contract.js';

/** Narrow the shared owner bar to a proved app session, even on an open local install. */
export function browserViewerPrincipal(
  facts: RequestFacts,
  sharedOwnerBarPassed: boolean
): ViewerPrincipal | null {
  const clientId = facts.headers['x-client-id'];
  if (
    !sharedOwnerBarPassed ||
    presentsAgentIdentity(facts) ||
    presentsProgramCredential(facts) ||
    facts.headers[APPROVAL_TOKEN_HEADER] !== undefined ||
    facts.user?.credential !== 'cookie' ||
    !facts.user.sessionId ||
    typeof clientId !== 'string' ||
    !/^[\w.-]{1,128}$/.test(clientId)
  )
    return null;
  return { ownerId: facts.user.userId, sessionId: facts.user.sessionId, clientId };
}
