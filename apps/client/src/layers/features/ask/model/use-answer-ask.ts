/**
 * Answering an Ask, wherever the card happens to be drawn.
 *
 * One mutation that fans by kind to the six transport methods that already
 * exist. Nothing new is invented on the way out: a permission prompt is still
 * `approveTool` / `denyTool`, a burst is still `batchApprove` / `batchDeny`, a
 * question is still `submitAnswers`, an elicitation is still `submitElicitation`.
 * What is new is only that the card asking can be anywhere.
 *
 * @module features/ask/model/use-answer-ask
 */
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import { useConfig } from '@/layers/entities/config';
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import {
  PENDING_INTERACTIONS_QUERY_KEY,
  forgetAskReceipt,
  recordAskReceipt,
  settleAsk,
} from '@/layers/entities/attention';
import { useTransport } from '@/layers/shared/model';
import { describeDecisionRefusal } from '@/layers/shared/lib';

/** What a person can say to an Ask from a card that is not the full prompt. */
type AskAnswer = 'allow' | 'deny';

/** What {@link useAnswerAsk} hands back. */
export interface AnswerAskState {
  /** Answer one prompt. */
  answer: (ask: InteractionPendingEvent, decision: AskAnswer) => Promise<void>;
  /** Answer a burst; remote allows confirm each request separately. */
  answerAll: (asks: readonly InteractionPendingEvent[], decision: AskAnswer) => Promise<void>;
  /** True while a request is in flight. */
  isAnswering: boolean;
  /** What went wrong, in the words a person can act on, or `null`. */
  error: string | null;
}

/**
 * Answer an Ask.
 *
 * Desk answers and lowering answers are optimistic and reversible. Remote
 * tool yeses wait for the server's per-request confirmation before any receipt.
 * For an optimistic answer, the receipt is written and the entry
 * leaves the list immediately, so every copy of the card on every surface stops
 * being a button. If the server refuses — the 403 from the answer guard is the
 * one that matters — the entry is put back by the next read and the refusal is
 * surfaced in the words `decision-refusal` already writes for capability
 * approvals, because a card that silently stayed answered would be a lie about
 * something a person cares about.
 *
 * A click that races a resolution is answered by the server's own idempotent
 * no-op, so it settles into the same receipt rather than an error.
 */
export function useAnswerAsk(): AnswerAskState {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const remotely = useConfig().data?.approvalAnswerContext?.answerNeedsStepUp ?? true;
  const [isAnswering, setIsAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (
      answered: readonly InteractionPendingEvent[],
      run: () => Promise<unknown>,
      decision: AskAnswer
    ) => {
      setIsAnswering(true);
      setError(null);
      const deferred =
        decision === 'allow' &&
        remotely &&
        answered.some((ask) => ask.interaction.type === 'approval');
      const openedFrom =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const record = () => {
        const resolvedAt = new Date().toISOString();
        for (const ask of answered) {
          recordAskReceipt(ask.interaction.id, {
            outcome: 'answered',
            resolvedAt,
            byThisWindow: true,
            decision: decision === 'allow' ? 'allowed' : 'denied',
          });
          // Keep it drawn while it says so. Without this the refetch below takes
          // the card away in the same frame the answer lands, which is the
          // disappearance the design rules out.
          settleAsk(ask);
        }
      };
      if (!deferred) record();
      try {
        await run();
        if (deferred) record();
        return true;
      } catch (err) {
        // Put the card back. The receipt was written before the server agreed,
        // and a refusal means it never did — leaving it would show "You allowed
        // this" over a request still sitting there answerable.
        if (!deferred) for (const ask of answered) forgetAskReceipt(ask.interaction.id);
        if ((err as { code?: string }).code !== STEP_UP_REQUIRED_CODE)
          setError(describeDecisionRefusal(err, false).message);
        if (deferred) requestAnimationFrame(() => openedFrom?.isConnected && openedFrom.focus());
        return false;
      } finally {
        setIsAnswering(false);
        // The stream's own `interaction_resolved` is what normally retires the
        // entry. Re-reading here is what brings the card BACK after a refusal:
        // the receipt is already forgotten above, so the restored row draws its
        // buttons again rather than a sentence about an answer nobody took.
        void queryClient.invalidateQueries({ queryKey: PENDING_INTERACTIONS_QUERY_KEY });
      }
    },
    [queryClient, remotely]
  );

  const answer = useCallback(
    async (ask: InteractionPendingEvent, decision: AskAnswer) => {
      const { sessionId, interaction } = ask;
      const allow = decision === 'allow';
      await send(
        [ask],
        () => {
          if (interaction.type === 'question') {
            // A question has no yes/no. "Deny" on a question card is the
            // decline every runtime already understands as an empty answer, and
            // "allow" never reaches here — the question card submits its own
            // answers through its own form.
            return transport.submitAnswers(sessionId, interaction.id, {});
          }
          if (interaction.type === 'elicitation') {
            return transport.submitElicitation(
              sessionId,
              interaction.id,
              allow ? 'accept' : 'decline'
            );
          }
          return allow
            ? transport.approveTool(sessionId, interaction.id)
            : transport.denyTool(sessionId, interaction.id);
        },
        decision
      );
    },
    [send, transport]
  );

  const answerAll = useCallback(
    async (asks: readonly InteractionPendingEvent[], decision: AskAnswer) => {
      const first = asks[0];
      if (first === undefined) return;
      if (decision === 'allow' && remotely) {
        for (const ask of asks) {
          const ok = await send(
            [ask],
            () => transport.approveTool(ask.sessionId, ask.interaction.id),
            decision
          );
          if (!ok) break;
        }
        return;
      }
      const ids = asks.map((ask) => ask.interaction.id);
      await send(
        asks,
        () =>
          decision === 'allow'
            ? transport.batchApprove(first.sessionId, ids)
            : transport.batchDeny(first.sessionId, ids),
        decision
      );
    },
    [send, transport, remotely]
  );

  return { answer, answerAll, isAnswering, error };
}
