/**
 * The Inbox's rows for what extensions are asking a person (spec
 * `flow-multiproject` §7.5, V2, V8).
 *
 * @module widgets/inbox-bell/ui/ExtensionDecisionList
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
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

/** Fields a person types into. A checkbox or a button is not one. */
const TEXT_ENTRY =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]';

/** The first control in a row, where focus lands when a row above it leaves. */
const ROW_FOCUS_TARGET = 'button:not([disabled])';

/** Props for {@link ExtensionDecisionList}. */
export interface ExtensionDecisionListProps {
  /** The decisions to draw, oldest first. */
  decisions: readonly ExtensionDecisionDTO[];
  /** Open an in-app path (a checked link), closing the Inbox first. */
  onNavigate: (path: string) => void;
  /** Open a chat the extension started. */
  onWatch: (sessionId: string) => void;
  /** Drawn as part of a longer list, which spaces it: no margin of its own. */
  flush?: boolean;
  /** The decision a link asked to single out: focused and ringed. */
  focusId?: string;
  /** Focus left the singled-out row: the link is spent. */
  onFocusSpent?: () => void;
}

/**
 * One decision's frame: the `data-decision-id` the focus rules find rows by,
 * and, for the decision a link asked for (`?inbox=<id>`), focus and a ring.
 *
 * The row focuses ITSELF when it mounts singled out, rather than the bell
 * reaching in after opening: the panel's content arrives a commit after the
 * open (it is portalled), and a decision fetched after a cold load arrives
 * later still. Focusing first also keeps the panel's own autofocus off it,
 * since that only moves focus that is not already inside.
 *
 * A row that arrives while the person is typing in the panel (a reply, a
 * note) scrolls into view and takes the ring, but leaves focus in the field.
 * Focus on a button does not count: the popover puts it there on its own.
 * Focus leaving the row spends the link: the ring goes, so the same link
 * again focuses it again. A row ringed but never focused keeps its ring until
 * the Inbox closes, as the mark of what the link was for.
 */
function DecisionFrame({
  decisionId,
  focused,
  onFocusSpent,
  children,
}: {
  decisionId: string;
  focused: boolean;
  onFocusSpent?: () => void;
  children: (titleId: string) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Whether this row has ever been drawn NOT singled out. Until it has, it is
  // a row that arrived singled out. A ref rather than a mount flag so React's
  // development double-run of effects reads the same answer twice.
  const everPlain = useRef(false);
  useEffect(() => {
    const frame = ref.current;
    if (!focused) {
      everPlain.current = true;
      return;
    }
    if (!frame) return;
    // Optional: jsdom has no layout, so no `scrollIntoView`.
    frame.scrollIntoView?.({ block: 'nearest' });
    // Only a row that ARRIVES singled out defers to where the person already
    // is. One already on screen was asked for again, so it takes focus.
    // Typing, not merely being somewhere: on a desktop cold load the popover
    // has already moved focus to its first button, and that is not the person.
    const panel = frame.closest<HTMLElement>('[role="dialog"]');
    const active = document.activeElement;
    const typingInPanel =
      !!panel &&
      active instanceof HTMLElement &&
      panel.contains(active) &&
      (active.matches(TEXT_ENTRY) || active.isContentEditable);
    if (!everPlain.current && typingInPanel) return;
    frame.focus({ preventScroll: true });
  }, [focused]);
  return (
    <div
      ref={ref}
      data-decision-id={decisionId}
      data-focused={focused ? 'true' : undefined}
      // A group named by its title, so when the frame itself holds focus a
      // screen reader says which ask it is (once: labelled-by, not a copy).
      role="group"
      aria-labelledby={titleId}
      tabIndex={focused ? -1 : undefined}
      className={focused ? 'ring-ring rounded-md ring-2 outline-none' : undefined}
      onBlur={
        focused
          ? (event) => {
              // Focus moving onto the row's own buttons is still on the row,
              // and the window losing focus (no next target) is not a move.
              const next = event.relatedTarget as Node | null;
              if (next !== null && !event.currentTarget.contains(next)) onFocusSpent?.();
            }
          : undefined
      }
    >
      {children(titleId)}
    </div>
  );
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
 * Answers are the person's, through core's own endpoint, and name the version
 * of the question they saw. A field stays open with its text until its answer
 * goes through. When a row leaves, focus moves to the next row, or to the
 * "Needs You" heading when it was the last.
 *
 * @param props - The decisions and where links go.
 */
export function ExtensionDecisionList({
  decisions,
  onNavigate,
  onWatch,
  flush = false,
  focusId,
  onFocusSpent,
}: ExtensionDecisionListProps) {
  const { answer, pendingFor } = useExtensionDecisionActions();
  const listRef = useRef<HTMLDivElement>(null);
  if (decisions.length === 0) return null;
  const now = new Date();

  /** Keep focus somewhere real after a row that held it leaves. */
  const refocusAfter = (decisionId: string) => {
    const list = listRef.current;
    if (!list || !list.contains(document.activeElement)) return;
    // The whole "Needs You" list, when this row sits in one; else just this list.
    const scope = list.closest<HTMLElement>('[data-slot="inbox-waiting"]') ?? list;
    const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-decision-id]'));
    const index = rows.findIndex((row) => row.dataset.decisionId === decisionId);
    setTimeout(() => {
      const remaining = Array.from(
        scope.querySelectorAll<HTMLElement>('[data-decision-id]')
      ).filter((row) => row.dataset.decisionId !== decisionId);
      const next = remaining[Math.min(index, remaining.length - 1)];
      const target =
        next?.querySelector<HTMLElement>(ROW_FOCUS_TARGET) ??
        document.querySelector<HTMLElement>('[data-inbox-needs-you-heading]');
      target?.focus();
    }, 0);
  };

  const send = async (
    decision: ExtensionDecisionDTO,
    request: Omit<DecisionActionRequest, 'revision'>
  ): Promise<boolean> => {
    const response = await answer({ decision, request });
    if (!response) return false;
    if (response.resolved) refocusAfter(decision.id);
    if (response.navigate) onNavigate(response.navigate);
    return true;
  };

  const actionsOf = (decision: ExtensionDecisionDTO): InboxDecisionRowProps['actions'] => {
    const actions = decision.actions;
    switch (actions.kind) {
      case 'yes-no':
        return {
          kind: 'yes-no',
          approveLabel: actions.approveLabel,
          rejectLabel: actions.rejectLabel,
          onApprove: () => void send(decision, { action: 'approve' }),
          onReject: () => void send(decision, { action: 'reject' }),
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
          onChoose: (choiceId) => void send(decision, { action: 'choice', choiceId }),
          onReply: (text) => send(decision, { action: 'choice', text }),
        };
      }
    }
  };

  return (
    <div
      ref={listRef}
      data-slot="extension-decision-list"
      className={flush ? 'flex flex-col gap-1' : 'mt-2 flex flex-col gap-1'}
    >
      {decisions.map((decision) => (
        <DecisionFrame
          key={decision.id}
          decisionId={decision.id}
          focused={decision.id === focusId}
          onFocusSpent={onFocusSpent}
        >
          {(titleId) => (
            <InboxDecisionRow
              icon={MessageCircleQuestion}
              title={decision.title}
              why={decision.why}
              sourceLine={decision.extensionName}
              meta={sinceLine(decision.since, decision.raisedAt, now) ?? undefined}
              notice={decision.needsYou ? NEEDS_YOU : undefined}
              more={decision.detail ? <p className="break-words">{decision.detail}</p> : undefined}
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
              pending={pendingFor(decision.id)}
              draftKey={decision.id}
              titleId={titleId}
            />
          )}
        </DecisionFrame>
      ))}
    </div>
  );
}
