import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PumpCrash } from '../session-pump-contract.js';
import { CredentialsUnreadableError } from '../../tooling/credential-read-health.js';
/**
 * The `result` a dead process never got to send.
 *
 * Deliberately carries no `terminal_reason`: the mapper turns a non-success
 * subtype into a typed `error` event, and `feedProjector`'s existing error latch
 * settles the window as `turn_end{terminalReason:'error'}`. Resolving the
 * terminal by the existing rules is the spec's instruction, and it beats
 * inventing an SDK reason string that the SDK itself never emits.
 */
export function crashResult(crash: PumpCrash): SDKMessage {
  const detail = crash.error instanceof Error ? crash.error.message : undefined;
  return {
    type: 'result',
    subtype:
      crash.error instanceof CredentialsUnreadableError
        ? crash.error.code
        : 'error_during_execution',
    is_error: true,
    errors: [
      crash.error instanceof CredentialsUnreadableError
        ? crash.error.message
        : detail === undefined
          ? 'The agent stopped before it finished this turn.'
          : `The agent stopped before it finished this turn: ${detail}`,
    ],
    uuid: `crash-${crash.sessionId}`,
    session_id: crash.sessionId,
  } as unknown as SDKMessage;
}
