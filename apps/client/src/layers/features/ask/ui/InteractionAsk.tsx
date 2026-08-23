/**
 * One Ask, drawn from what the fleet-wide stream carries.
 *
 * The adopter every surface outside the transcript uses: the header pill, the
 * home triage header, the sidebar's rows, and the room's live lane all render
 * this, so answering is the same gesture wherever a person happens to be
 * standing. The transcript keeps rendering the full prompts instead — it has the
 * whole conversation around them, and a question's form belongs there.
 *
 * @module features/ask/ui/InteractionAsk
 */
import { useEffect, useRef, useState } from 'react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import { useAskReceipt } from '@/layers/entities/attention';
import { useNow } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { askHeadline } from '../lib/ask-headline';
import { formatAskTimeLeft } from '../lib/format-time-left';
import { useAnswerAsk } from '../model/use-answer-ask';
import { AskCard } from './AskCard';
import { AskReceiptLine } from './AskReceiptLine';

/** What {@link InteractionAsk} takes. */
export interface InteractionAskProps {
  /** The prompt to draw. */
  ask: InteractionPendingEvent;
  /** What to call the asking agent, when the surface holds the roster. */
  agentName?: string;
  /** Whether this card is the keyboard shortcut's current target. */
  isActive?: boolean;
  /** Take focus on mount — set only by the shortcut that deliberately moved here. */
  autoFocus?: boolean;
  /** Where "Open session" should go; absent hides the action. */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}

/** How often the countdown re-reads the clock. */
const TICK_MS = 1000;

/**
 * A prompt, its time left, and the two answers.
 *
 * It never steals focus: it arrives with the message-entrance grammar and sits
 * there. `A` and `D` answer it only while focus is inside the card, and the only
 * thing that puts focus there is a person pressing `⌘⇧Y` or clicking it.
 *
 * When the prompt is answered — here, in another window, or by the clock — the
 * actions are removed in the same commit the receipt appears. The design rule is
 * "never a button that does nothing", and this is what it is implemented as.
 */
export function InteractionAsk({
  ask,
  agentName,
  isActive = false,
  autoFocus = false,
  onOpenSession,
  className,
}: InteractionAskProps) {
  const now = useNow(TICK_MS);
  // Fixed at mount, so the legacy fallback below cannot drift with the tick.
  const [mountedAt] = useState(() => Date.now());
  const receipt = useAskReceipt(ask.interaction.id);
  const { answer, isAnswering, error } = useAnswerAsk();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) cardRef.current?.focus();
  }, [autoFocus]);

  const { interaction } = ask;
  // **Anchored to the START, not to what was left when this arrived.**
  // `remainingMs` is the budget minus the time already spent, so
  // `startedAt + remainingMs` lands in the past for anything more than half way
  // through — a question listed six minutes into its ten was born expired
  // (DOR-1330 review). The server stamps `timeoutMs` on every kind for exactly
  // this.
  //
  // No live DTO reaches the fallback below: `listPendingInteractions` is the
  // sole producer and it stamps a budget on every unparked one, computing it
  // fresh on each read rather than replaying a stored value — so even a DTO
  // rebuilt from a durable event that predates the field arrives with one. The
  // branch is kept only so a hand-built or third-party DTO renders honestly,
  // counting from NOW, which is the only honest reading of a bare remainder.
  //
  // A prompt is PARKED once its countdown is out, and a card that ARRIVES parked
  // must read exactly like one that parked while somebody was looking at it
  // (spec `ask-parks-on-timeout` §9). Two facts say the same thing, so both are
  // read: the server drops `timeoutMs` and stamps `parked` on a prompt it
  // already knows has run out, and a card holding an older DTO gets there on its
  // own clock. Either way the countdown becomes `null` and the draining bar has
  // no budget to draw against — the agent is waiting, not running out of time.
  const declaredMs = interaction.timeoutMs;
  const deadline =
    declaredMs === undefined
      ? mountedAt + interaction.remainingMs
      : interaction.startedAt + declaredMs;
  const secondsRun = Math.max(0, Math.ceil((deadline - now) / 1000));
  const parked = interaction.parked === true || secondsRun <= 0;
  const secondsLeft = parked ? null : secondsRun;
  const budgetMs = parked ? undefined : declaredMs;

  // What the prompt itself said, when it said anything. The inline card in the
  // transcript has always shown this; a fleet-wide card that showed only the
  // headline asked a person to approve a file it would not name.
  const detail =
    interaction.type === 'approval'
      ? (interaction.description ?? interaction.blockedPath)
      : interaction.type === 'elicitation'
        ? interaction.message
        : undefined;
  const reason = interaction.type === 'approval' ? interaction.decisionReason : undefined;

  return (
    <AskCard.Root
      ref={cardRef}
      isActive={isActive}
      isResolved={receipt !== undefined}
      {...(receipt === undefined
        ? { onAllow: () => void answer(ask, 'allow'), onDeny: () => void answer(ask, 'deny') }
        : {})}
      className={className}
      data-testid="interaction-ask"
      data-interaction-id={interaction.id}
      data-session-id={ask.sessionId}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AskCard.Face cwd={ask.cwd} />
        <AskCard.Headline className="min-w-0 flex-1 truncate">
          {askHeadline(ask, agentName)}
        </AskCard.Headline>
      </div>

      {(detail !== undefined || reason !== undefined) && (
        <AskCard.Detail className="mt-1 pl-8">
          {detail !== undefined && <p className="truncate font-mono">{detail}</p>}
          {reason !== undefined && <p>{reason}</p>}
        </AskCard.Detail>
      )}

      {receipt === undefined && (
        <div className="mt-2">
          <AskCard.Countdown
            secondsLeft={secondsLeft}
            {...(budgetMs !== undefined ? { timeoutMs: budgetMs } : {})}
            elapsedMs={Math.max(0, now - interaction.startedAt)}
            label={formatAskTimeLeft(secondsLeft)}
          />
        </div>
      )}

      {error && <p className="text-status-error text-2xs mt-2">{error}</p>}

      <div className="mt-2">
        {receipt ? (
          <AskReceiptLine receipt={receipt} />
        ) : (
          <AskCard.Actions>
            {interaction.type !== 'question' && (
              <Button
                size="sm"
                data-slot="ask-allow"
                disabled={isAnswering}
                onClick={() => void answer(ask, 'allow')}
              >
                Allow
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              data-slot="ask-deny"
              disabled={isAnswering}
              onClick={() => void answer(ask, 'deny')}
            >
              {interaction.type === 'question' ? 'Skip' : 'Deny'}
            </Button>
            {onOpenSession && (
              <Button
                size="sm"
                variant="ghost"
                data-slot="ask-open-session"
                onClick={() => onOpenSession(ask.sessionId)}
              >
                Open session
              </Button>
            )}
          </AskCard.Actions>
        )}
      </div>
    </AskCard.Root>
  );
}
