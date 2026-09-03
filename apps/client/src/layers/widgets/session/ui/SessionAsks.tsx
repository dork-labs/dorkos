/**
 * The prompt that takes the session's composer while it waits for an answer.
 *
 * `Conversation.Composer`'s `asks` slot, filled by the one surface that has
 * one: a session's inline prompt REPLACES the box, because there is nothing to
 * type into while the agent is parked on a question. A channel draws its Asks
 * in the lane instead — one card, in the place the work is happening (§4.1's
 * dedupe rule).
 *
 * @module widgets/session/ui/SessionAsks
 */
import { useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ToolCallState } from '@/layers/shared/model/chat-message-types';
import { ApprovalPrompt, AskStack, QuestionPrompt, useAnswerAsk } from '@/layers/features/ask';
import { getToolLabel } from '@/layers/shared/lib';
import type { InteractiveToolHandle } from '@/layers/features/chat';

/**
 * The next queued card rises into the slot the answered one vacated. The short
 * delay is the point: without it the replacement appears under a cursor that
 * has not moved yet, and the answer feels like it landed on the wrong card.
 */
const NEXT_CARD_TRANSITION = { duration: 0.16, delay: 0.08, ease: [0.16, 1, 0.3, 1] } as const;

/** Reduced motion swaps the card with no travel and no time. */
const INSTANT_TRANSITION = { duration: 0 } as const;

interface SessionAsksProps {
  sessionId: string;
  /** The active tool call — guaranteed non-null by the parent's mode check. */
  activeInteraction: ToolCallState;
  pendingApprovals: ToolCallState[];
  focusedOptionIndex: number;
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  onToolDecided: (toolCallId: string, answers?: Record<string, string>) => void;
  /**
   * How many messages are still queued behind this card. This prompt replaces
   * the whole composer, queue panel included, so without a mark here the person
   * sees their queued messages disappear at the one moment that looks like
   * loss. They are safe; this says so and nothing more.
   */
  queueDepth?: number;
  /**
   * Whether this session's runtime can deliver a free-text deny reason to the
   * agent. Passed straight through to `ApprovalPrompt` — see its own prop for
   * why (DOR-825).
   */
  allowsDenyReason?: boolean;
}

/**
 * Draw the prompt this session is parked on.
 *
 * @param props - The active prompt, the burst behind it, and what is queued.
 */
export function SessionAsks({
  sessionId,
  activeInteraction,
  pendingApprovals,
  focusedOptionIndex,
  onToolRef,
  onToolDecided,
  queueDepth = 0,
  allowsDenyReason = true,
}: SessionAsksProps) {
  // Forward submitted question answers so they're persisted onto the tool-call
  // part immediately — otherwise the inline answered row briefly shows the
  // generic "N questions answered" until history reloads. (Approvals pass none.)
  const handleDecided = (answers?: Record<string, string>) =>
    onToolDecided(activeInteraction.toolCallId, answers);

  const reducedMotion = useReducedMotion();

  // The burst form, in place of the batch bar it replaced: two or more
  // approvals queued in this session read as one decision and are answered
  // once.
  //
  // Through the SHARED mutation, not a second copy of the two transport calls:
  // this used to swallow a refusal into `console.error`, so an answer the
  // server rejected looked exactly like one it took. `useAnswerAsk` writes the
  // receipts, takes them back when the server says no, and hands back the
  // sentence to show.
  const { answerAll, isAnswering, error } = useAnswerAsk();
  const burst = useMemo(
    () =>
      pendingApprovals.map((call) => ({
        sessionId,
        // The panel holds tool calls, not fleet envelopes; only the ids reach
        // the transport, and the directory is the session's own.
        cwd: '',
        interaction: {
          type: 'approval' as const,
          id: call.toolCallId,
          // Zero rather than a clock read: only the ids reach the transport
          // from here, and a `Date.now()` in a render body is an unstable value
          // the rules of React are right to object to. The burst card in the
          // TRAY draws from real envelopes and has real times.
          startedAt: call.approvalStartedAt ?? 0,
          remainingMs: call.timeoutMs ?? 0,
          toolName: call.toolName,
          input: call.input ?? '',
          hasSuggestions: call.approvalHasSuggestions ?? false,
        },
      })),
    [pendingApprovals, sessionId]
  );

  return (
    <>
      {pendingApprovals.length >= 2 && (
        <AskStack
          className="mb-1.5"
          headline={`${pendingApprovals.length} tools are waiting on you`}
          items={pendingApprovals.map((call) => ({
            id: call.toolCallId,
            line: getToolLabel(call.toolName, call.input ?? ''),
          }))}
          onAllowAll={() => void answerAll(burst, 'allow')}
          onDenyAll={() => void answerAll(burst, 'deny')}
          isAnswering={isAnswering}
          error={error}
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeInteraction.toolCallId}
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reducedMotion ? INSTANT_TRANSITION : NEXT_CARD_TRANSITION}
        >
          {activeInteraction.interactiveType === 'approval' ? (
            <ApprovalPrompt
              ref={onToolRef}
              sessionId={sessionId}
              toolCallId={activeInteraction.toolCallId}
              toolName={activeInteraction.toolName}
              input={activeInteraction.input || ''}
              isActive
              onDecided={handleDecided}
              timeoutMs={activeInteraction.timeoutMs}
              approvalStartedAt={activeInteraction.approvalStartedAt}
              approvalRemainingMs={activeInteraction.approvalRemainingMs}
              approvalParked={activeInteraction.approvalParked}
              approvalTitle={activeInteraction.approvalTitle}
              approvalDisplayName={activeInteraction.approvalDisplayName}
              approvalDescription={activeInteraction.approvalDescription}
              approvalBlockedPath={activeInteraction.approvalBlockedPath}
              approvalDecisionReason={activeInteraction.approvalDecisionReason}
              approvalHasSuggestions={activeInteraction.approvalHasSuggestions}
              approvalAlwaysAllowScope={activeInteraction.approvalAlwaysAllowScope}
              allowsDenyReason={allowsDenyReason}
            />
          ) : activeInteraction.interactiveType === 'question' && activeInteraction.questions ? (
            <QuestionPrompt
              ref={onToolRef}
              sessionId={sessionId}
              toolCallId={activeInteraction.toolCallId}
              questions={activeInteraction.questions}
              answers={activeInteraction.answers}
              isActive
              focusedOptionIndex={focusedOptionIndex}
              onDecided={handleDecided}
            />
          ) : null}
        </motion.div>
      </AnimatePresence>
      {queueDepth > 0 && (
        <p className="text-muted-foreground px-1 pt-2 text-xs">
          {queueDepth === 1
            ? '1 message is waiting. It sends once you answer.'
            : `${queueDepth} messages are waiting. They send once you answer.`}
        </p>
      )}
    </>
  );
}
