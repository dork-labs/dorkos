/**
 * Who may set an extension's secret without the owner's confirm: an agent
 * DorkOS identified, on a turn that read nothing from outside the team
 * (DOR-1801). A marked turn, or an agent header DorkOS can't resolve, is
 * refused, the same rule a chat connection's typed secret follows (DOR-3858):
 * an outsider could otherwise swap an extension's key for one on an account
 * they control (Security S3 on DOR-4355 M3).
 *
 * @module routes/extension-secret-agent-gate
 */
import type { Context } from 'hono';
import { env } from '../env.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { marksOf } from '../services/core/turn-power/turn-levels.js';
import { marksHold } from '../services/core/turn-power/turn-marks.js';
import { markedTurnSecretRefusal } from '../services/relay/secrets/marked-turn-secret-gate.js';

/**
 * The refusal for an agent setting an extension secret from a marked turn or
 * with an agent header DorkOS can't resolve, or `null` when the caller isn't
 * one. A person, a signed-in account and an API key present no agent header,
 * so they aren't this rule's to judge.
 *
 * @param c - The request.
 */
export function markedExtensionSecretRefusal(
  c: Context<ApiEnv>
): ReturnType<typeof markedTurnSecretRefusal> {
  const facts = honoRequestFacts(c);
  const identity = facts.agentIdentity;
  const unidentified = identity === undefined && presentsAgentIdentity(facts);
  if (identity === undefined && !unidentified) return null;
  // An HTTP agent call names no chat, so its marks are read through its verified agent folder.
  const turnMarked = identity !== undefined && marksHold(marksOf(undefined, identity.agentPath));
  return markedTurnSecretRefusal({
    enabled: env.DORKOS_MARK_STRANGER_TURNS,
    writer: 'agent',
    turnMarked,
    unidentified,
    typedSecret: true,
  });
}
