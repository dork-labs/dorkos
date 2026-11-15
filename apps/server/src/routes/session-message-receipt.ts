/** The HTTP receipt preserves launch warnings instead of dropping them at the route. */
import type { DispatchSessionMessageResult } from '../services/session/launch/launch-session.js';

/** Return only the public acceptance fields, including tool-availability warnings. */
export function sessionMessageReceipt(
  result: Exclude<DispatchSessionMessageResult, { refused: string }>
) {
  return {
    sessionId: result.canonicalId,
    messageId: result.outcome.messageId,
    outcome: result.outcome,
    queuePosition: result.queuePosition,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}
