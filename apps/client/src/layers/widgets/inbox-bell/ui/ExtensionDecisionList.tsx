/**
 * The Inbox's rows for what extensions are asking a person (spec
 * `flow-multiproject` §7.5, V2, V8).
 *
 * @module widgets/inbox-bell/ui/ExtensionDecisionList
 */
import { MessageCircleQuestion } from 'lucide-react';
import type {
  DecisionActionRequest,
  ExtensionDecisionDTO,
} from '@dorkos/shared/extension-decision-schemas';
import { useExtensionDecisionActions } from '@/layers/entities/extension';
import {
  InboxDecisionRow,
  deadlineLine,
  sinceLine,
  type InboxDecisionRowProps,
} from '@/layers/features/inbox';

/** What a row says when the agent's pick could not be applied at the deadline. */
const NEEDS_YOU = 'The agent couldn’t go ahead. It needs you.';

/** Props for {@link ExtensionDecisionList}. */
export interface ExtensionDecisionListProps {
  /** The decisions to draw, oldest first. */
  decisions: readonly ExtensionDecisionDTO[];
  /** Open an in-app path (a checked link), closing the Inbox first. */
  onNavigate: (path: string) => void;
  /** Open a chat the extension started. */
  onWatch: (sessionId: string) => void;
}

/**
 * One row per decision: its title, the line that says why, the extension's
 * name as core knows it (never text the extension supplied, so one extension
 * cannot dress a row up as another's), and its answers.
 *
 * - yes or no: ⓘ (when there is more to say), 👎 and 👍, labelled as outcomes.
 *   A 👎 that asks for a note opens a short field first; it never closes
 *   anything by itself.
 * - one word: a small button, which opens a page in the app or an inline field.
 * - a question: chips with the agent's pick marked, "Reply…", and the
 *   deadline line when there is a deadline.
 *
 * Answers are the person's, through core's own endpoint. A decision the
 * extension keeps open stays; one it settles leaves, and its history row may
 * carry a one-time "next time, on its own?" line.
 *
 * @param props - The decisions and where links go.
 */
export function ExtensionDecisionList({
  decisions,
  onNavigate,
  onWatch,
}: ExtensionDecisionListProps) {
  const { answer, pending } = useExtensionDecisionActions();
  if (decisions.length === 0) return null;
  const now = new Date();

  const send = (decision: ExtensionDecisionDTO, request: DecisionActionRequest) => {
    void answer({ decision, request }).then((response) => {
      if (response?.navigate) onNavigate(response.navigate);
    });
  };

  const actionsOf = (decision: ExtensionDecisionDTO): InboxDecisionRowProps['actions'] => {
    const actions = decision.actions;
    switch (actions.kind) {
      case 'yes-no':
        return {
          kind: 'yes-no',
          approveLabel: actions.approveLabel,
          rejectLabel: actions.rejectLabel,
          onApprove: () => send(decision, { action: 'approve' }),
          onReject: () => send(decision, { action: 'reject' }),
          ...(actions.rejectAsksForNote
            ? {
                rejectNote: {
                  onSubmit: (note: string) => send(decision, { action: 'reject', note }),
                },
              }
            : {}),
        };
      case 'word': {
        const { href, input } = actions;
        return {
          kind: 'word',
          label: actions.label,
          onClick: () => {
            if (href) onNavigate(href);
          },
          ...(input
            ? {
                input: {
                  placeholder: input.placeholder,
                  maxLength: input.maxLength,
                  onSubmit: (text: string) => send(decision, { action: 'word', text }),
                },
              }
            : {}),
        };
      }
      case 'choice': {
        const pick = actions.choices.find((c) => c.id === actions.defaultChoice) ?? null;
        return {
          kind: 'choice',
          choices: actions.choices,
          defaultChoiceId: pick?.id ?? null,
          deadlineLine: deadlineLine(actions.decideBy, pick?.label ?? null, now),
          allowReply: actions.allowReply === true,
          onChoose: (choiceId) => send(decision, { action: 'choice', choiceId }),
          onReply: (text) => send(decision, { action: 'choice', text }),
        };
      }
    }
  };

  return (
    <div data-slot="extension-decision-list" className="mt-2 flex flex-col gap-1">
      {decisions.map((decision) => {
        const busy = pending?.id === decision.id ? pending.action : null;
        return (
          <InboxDecisionRow
            key={decision.id}
            icon={MessageCircleQuestion}
            title={decision.title}
            why={decision.why}
            sourceLine={decision.extensionName}
            meta={sinceLine(decision.since, decision.raisedAt, now) ?? undefined}
            notice={decision.needsYou ? NEEDS_YOU : undefined}
            more={decision.detail ? <p>{decision.detail}</p> : undefined}
            onOpen={decision.link ? () => onNavigate(decision.link as string) : undefined}
            watch={
              decision.watch
                ? {
                    label: decision.watch.label,
                    onWatch: () => onWatch(decision.watch!.sessionId),
                  }
                : null
            }
            actions={actionsOf(decision)}
            pending={busy}
          />
        );
      })}
    </div>
  );
}
