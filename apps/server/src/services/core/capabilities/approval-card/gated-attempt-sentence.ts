/**
 * The sentence on an approval card: who asked and what they want to run.
 * Split out of `tier-enforcement.ts`, which re-exports it and is the gate that
 * calls it.
 *
 * @module services/core/capabilities/approval-card/gated-attempt-sentence
 */
import type { ApprovalServiceAction, ApprovalSubject } from '@dorkos/shared/approval-schemas';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import {
  extensionSourcePhrase,
  joinSummaryFields,
  redactSecretsInText,
  renderRequesterLabel,
  summaryFieldsNamingSubject,
} from '../../approvals/index.js';
// Type-only: the gate imports this module, never the reverse at runtime.
import type { GatedAction } from '../tier-enforcement.js';

/**
 * The plain sentence a person reads on the approval card.
 *
 * Says who asked, what they want to run (the registry's title, never the
 * requester's own words), and the arguments that decide what it does.
 *
 * ## The requester cannot forge this sentence
 *
 * Everything caller-controlled — argument values AND the agent's own display name
 * — is rendered through `services/core/approvals/approval-summary.ts`, which
 * quotes strings, caps each value, and strips anything token-shaped. Review
 * reproduced the attack this closes: `{ name: 'pkg, purge: no', purge: true }` used
 * to render a fake `purge: no` before the real `purge: yes`, and padding the
 * injected value pushed the true one out of the card's clamp. Read that module
 * before changing the rendering.
 *
 * Which fields appear is the action's own declaration (`approvalDisplayFields`),
 * so a field like `confirmationToken` never reaches a card, an event, or the
 * agent-readable pending list.
 *
 * An unidentified caller is named as such rather than dressed up as an agent: a
 * person deciding an irreversible action should be able to see that DorkOS does
 * not know who asked.
 *
 * ## The subject field is rendered by NAME, and only here
 *
 * When the caller resolved a {@link ApprovalSubject}, the argument that names the
 * target renders as the registry's name for it instead of the raw id — so
 * `agentId: "01KXQ3P7ADJY9DSXMZW1XGWCV4"` becomes `agent: "Lab Scout"`. That
 * substitution happens in this one function, so every surface that renders THIS
 * SENTENCE gets the name without changing. That is a smaller set than it looks:
 * the approvals card and the stored approval row read it, while the Activity
 * feed composes its own line from `action.title` (`capability-gate-audit.ts`)
 * and the notification carries the title only, deliberately without argument
 * values (`notification-registry.ts`). So no surface loses the id by this
 * substitution — not because they all read the sentence, but because the ones
 * that do not never showed the id in the first place.
 *
 * The id does not disappear — it moves. The card carries it as
 * `PendingApproval.subject.id` beside the name, which is where a person checks
 * one against the other. Keeping BOTH in this sentence would spend the summary's
 * length budget re-printing the thing the subject block already shows, and the
 * budget is what stops a padded argument from crowding out a real one.
 *
 * With no subject resolved, nothing here changes: the raw id renders as it
 * always did. That is the whole fail-closed story — a card can lose the name,
 * never the argument.
 *
 * ## A connected-app action is described by what it does
 *
 * With a {@link ApprovalServiceAction}, the sentence names the action, the app
 * and the account instead of the two ids the action's input carries, and lists
 * the argument lines the card shows. Every value is quoted, and every label was
 * reduced to letters and digits where it was built, so a value still cannot
 * forge a second field.
 *
 * @param action - The capability or tool being requested.
 * @param input - The parsed input the approval is bound to.
 * @param identity - The agent asking, when it identified itself.
 * @param subject - The named target, when the caller could resolve one.
 * @param serviceAction - The connected-app action in words, when this is one.
 * @returns The card summary.
 */
export function describeGatedAttempt(
  action: GatedAction,
  input: unknown,
  identity?: AgentIdentity,
  subject?: ApprovalSubject,
  serviceAction?: ApprovalServiceAction
): string {
  const who = identity
    ? `${JSON.stringify(renderRequesterLabel(identity.displayName || identity.agentPath))} `
    : 'An unidentified caller ';
  if (serviceAction) {
    const lines = serviceAction.details
      .map(({ label, value }) => `${label}: ${JSON.stringify(value)}`)
      .join(', ');
    return redactSecretsInText(
      `${who}wants to run "${serviceAction.actionName}" in ${serviceAction.serviceName} on ` +
        `${JSON.stringify(serviceAction.accountLabel)}${lines ? ` with ${lines}` : ''}`
    );
  }
  // An action's own sentence is DorkOS's source, never an extension's: the
  // extension layer builds definitions without it.
  if (action.approvalSentence && !action.source) {
    return redactSecretsInText(`${who}${action.approvalSentence(input)}`);
  }
  const clause = joinSummaryFields(
    summaryFieldsNamingSubject(
      action.approvalView ? action.approvalView(input) : input,
      action.approvalDisplayFields,
      subject,
      action.approvalSubject?.field
    )
  );
  const detail = clause ? ` with ${clause}` : '';
  // A core title is declared in DorkOS's own source, so it is written as is. An
  // extension's title and name are its author's text (DOR-2685): both are
  // JSON-quoted, so neither can close the quote and forge a field after it,
  // and the card says which extension the tool comes from. `contribute` also
  // refuses quotes and control characters in both. The whole sentence gets
  // the secret sweep either way, because this string is broadcast.
  if (action.source) {
    return redactSecretsInText(
      `${who}wants to run ${JSON.stringify(action.title)}` +
        `${extensionSourcePhrase(action.source.name)}${detail}`
    );
  }
  return redactSecretsInText(`${who}wants to run "${action.title}"${detail}`);
}
