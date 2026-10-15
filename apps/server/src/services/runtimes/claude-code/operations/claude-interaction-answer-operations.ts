import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { InteractionAnswerOptions, ToolDecisionOptions } from '@dorkos/shared/agent-runtime';

/** Execute original approveTool behavior after actual runtime private-key admission. */
export function approveTool(
  ownerKey: object,
  sessionId: string,
  toolCallId: string,
  approved: boolean,
  options?: ToolDecisionOptions
): boolean {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const resolved = facet.sessionStore.approveTool(sessionId, toolCallId, approved, options);
  if (resolved) {
    // `reasonGiven` is asserted HERE, one line from the call that actually
    // handed the reason to the model, so the transcript's "agent was told
    // why" can never outrun what was delivered.
    facet.notifyInteractionResolved(sessionId, toolCallId, approved ? 'approved' : 'denied', {
      reasonGiven: !approved && (options?.denyReason?.trim() ?? '') !== '',
      ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
    });
  }
  return resolved;
}

/** Execute original submitAnswers behavior after actual runtime private-key admission. */
export function submitAnswers(
  ownerKey: object,
  sessionId: string,
  toolCallId: string,
  answers: Record<string, string>,
  options?: InteractionAnswerOptions
): boolean {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const resolved = facet.sessionStore.submitAnswers(sessionId, toolCallId, answers);
  if (resolved) {
    facet.notifyInteractionResolved(sessionId, toolCallId, 'answered', {
      ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
    });
  }
  return resolved;
}

/** Execute original submitElicitation behavior after actual runtime private-key admission. */
export function submitElicitation(
  ownerKey: object,
  sessionId: string,
  interactionId: string,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
  options?: InteractionAnswerOptions
): boolean {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const resolved = facet.sessionStore.submitElicitation(sessionId, interactionId, action, content);
  if (resolved) {
    facet.notifyInteractionResolved(
      sessionId,
      interactionId,
      action === 'accept' ? 'answered' : 'denied',
      { ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}) }
    );
  }
  return resolved;
}
