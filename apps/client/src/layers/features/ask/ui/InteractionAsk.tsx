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
import { useEffect, useRef } from 'react';
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
 * thing that puts focus there is a person pressing `⌘⇧A` or clicking it.
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
  const receipt = useAskReceipt(ask.interaction.id);
  const { answer, isAnswering, error } = useAnswerAsk();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) cardRef.current?.focus();
  }, [autoFocus]);

  const { interaction } = ask;
  // Only a permission prompt declares its own budget; a question and an
  // elicitation ride the server-wide one, and `remainingMs` at the moment the
  // prompt was listed is what stands in for it. Either way the countdown is
  // local from here — the wire carries no ticking number.
  const budgetMs = interaction.type === 'approval' ? interaction.timeoutMs : undefined;
  const deadline = interaction.startedAt + (budgetMs ?? interaction.remainingMs);
  const secondsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));

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
