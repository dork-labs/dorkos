/**
 * Why an Allow's answer did not reach an agent's request after the access
 * itself had been saved, read from the problem's `code` alone (DOR-4979), and
 * the one fix the card offers: send it again, turn the app back on for this
 * chat, choose the updates again or answer without them, or nothing.
 *
 * @module features/connections/lib/unanswered-reason
 */
import { serverSentence } from '@/layers/shared/lib';

/** The fix the card offers beside the reason. */
export type UnansweredFix = 'retry' | 'turn_on' | 'updates' | null;

/** Sending the same updates again would fail the same way. */
const UPDATES = 'The updates you picked can’t be set up. Pick again, or answer without them.';

/**
 * The reason and fix for a refused answer.
 *
 * @param error - What the answer's request rejected with.
 * @param agentName - The agent that asked.
 * @param serviceName - The app it asked for.
 */
export function unansweredReason(
  error: Error | null,
  agentName: string,
  serviceName: string
): { reason: string; fix: UnansweredFix } {
  switch ((error as { code?: string } | null)?.code) {
    case 'app_off_in_chat':
      // The chat's own switch is off. Turning it on is the same switch the
      // chat's details show: it only undoes that off, putting back the access
      // this chat had (its own hand-picked access, else what the agent has
      // everywhere), never more. The card offers it only when the chat's
      // readiness names it as the fix, then answers the request.
      return {
        reason: `This chat has ${serviceName} turned off for ${agentName}.`,
        fix: 'turn_on',
      };
    case 'already_resolved':
      return {
        reason: `It was answered somewhere else. Ask ${agentName} again if it still needs this.`,
        fix: null,
      };
    case 'expired':
      return { reason: `The request ran out of time. Ask ${agentName} again.`, fix: null };
    case 'not_found':
      // The request, the account or the agent: the server's sentence says which.
      return { reason: serverSentence(error) ?? 'The request is no longer open.', fix: null };
    case 'request_open_elsewhere':
      return { reason: 'Signing in already started another way. Finish that first.', fix: null };
    case 'temporarily_unavailable':
      return { reason: 'The access is still being set up.', fix: 'retry' };
    case 'precondition_failed':
      return { reason: 'Access changed since you looked. Try again.', fix: 'retry' };
    case 'conflict':
      return { reason: 'That account isn’t ready for it yet.', fix: 'retry' };
    case 'updates_unavailable':
    case 'updates_changed':
    case 'invalid_filter':
    case 'destination_unavailable':
      return { reason: UPDATES, fix: 'updates' };
    default:
      return { reason: serverSentence(error) ?? 'The answer didn’t reach DorkOS.', fix: 'retry' };
  }
}
