/**
 * The two things a turn can wait on that are not tool permissions, answered
 * the way a person in the DorkOS app would answer them, so the turn ends
 * instead of sitting out the 90-second guard.
 *
 * 1. **A held connection request.** `connectors.request_connection` creates a
 *    request and then HOLDS the call open (up to ten minutes,
 *    `CONNECTOR_REQUEST_LIVE_HOLD_MS`) waiting for the owner's answer. In a
 *    sandbox nobody answers, so the correct move (asking for the app) used to
 *    end as a turn-timeout `error`. The driver reads the owner's list,
 *    `GET /api/connectors/agent-requests?state=pending`, and answers each one
 *    at `POST /api/connectors/agent-requests/:id/decision` with
 *    `{decision: 'denied'}`: the same route and the same body the card in the
 *    chat sends when a person says no. "Denied" is the only answer the sandbox
 *    can give, since it has no account to give access to. The oracles read the
 *    CALL the model made, which the answer cannot change; what the model says
 *    afterwards is about a "no", and the reply proxies say so.
 * 2. **A question card.** Claude Code's `AskUserQuestion` arrives as a durable
 *    `question_prompt` frame and waits for `POST /api/sessions/:id/submit-answers`.
 *    The driver answers every question in it with one fixed line, so the turn
 *    goes on and the card stays on the stream for the oracles to count.
 *
 * Like every request the approval driver sends, these carry no `X-DorkOS-Agent`
 * and no `X-DorkOS-Approval` header, and no `Origin`: the owner boundary
 * (`routes/connector-owner-boundary.ts`) refuses programs and agents, and lets
 * through a local operator with login off, which is what an eval sandbox is.
 *
 * Nothing here throws. Every fault is returned as a line for the driver log.
 *
 * @module evals/runner/interaction-answers
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { ConnectionRequestAnswerRecord, QuestionAnswerRecord } from '../types.js';

/** The owner's list of agent requests still waiting for an answer. */
export const PENDING_CONNECTION_REQUESTS_PATH = '/api/connectors/agent-requests?state=pending';

/** The durable stream member a question card arrives as. */
const QUESTION_PROMPT = 'question_prompt';

/** A `question_prompt` frame's payload, as it is probed off `SseFrame.data`. */
interface QuestionPromptFrameData {
  type?: string;
  /** The card's id: the tool call `submit-answers` addresses. */
  id?: unknown;
  questions?: unknown;
}

/** One question card on the stream, ready to answer. */
export interface QuestionCard {
  /** The tool call id the answer is addressed to. */
  toolCallId: string;
  /** How many questions the card holds (answers are keyed by index). */
  count: number;
}

/**
 * Every question card in the frames, in order. A card with no id is skipped:
 * there is nothing to address an answer to.
 *
 * @param frames - Frames collected so far.
 * @returns The cards.
 */
export function questionCards(frames: SseFrame[]): QuestionCard[] {
  const cards: QuestionCard[] = [];
  for (const frame of frames) {
    const data = frame.data as QuestionPromptFrameData | undefined;
    if (frame.event !== QUESTION_PROMPT && data?.type !== QUESTION_PROMPT) continue;
    const toolCallId = typeof data?.id === 'string' && data.id !== '' ? data.id : undefined;
    if (!toolCallId) continue;
    const count = Array.isArray(data?.questions) ? Math.max(1, data.questions.length) : 1;
    cards.push({ toolCallId, count });
  }
  return cards;
}

/**
 * Answer one question card with `text` for each of its questions.
 *
 * @param baseUrl - The harness server.
 * @param sessionId - The session the card arrived on.
 * @param card - The card.
 * @param text - The answer given to every question.
 * @returns The record, and an error line when the answer did not land.
 */
export async function answerQuestionCard(
  baseUrl: string,
  sessionId: string,
  card: QuestionCard,
  text: string
): Promise<{ record?: QuestionAnswerRecord; error?: string }> {
  const answers = Object.fromEntries(
    Array.from({ length: card.count }, (_, index) => [String(index), text])
  );
  try {
    const res = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/submit-answers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId: card.toolCallId, answers }),
      }
    );
    const record = {
      toolCallId: card.toolCallId,
      answeredAt: new Date().toISOString(),
      status: res.status,
    };
    return res.ok
      ? { record }
      : { record, error: `answer to question ${card.toolCallId} returned ${res.status}` };
  } catch (err) {
    return { error: `answer to question ${card.toolCallId} failed: ${message(err)}` };
  }
}

/**
 * Read the owner's pending agent requests once and deny each one not already
 * answered.
 *
 * @param baseUrl - The harness server.
 * @param answered - Request ids already answered; updated in place.
 * @returns What was decided, and any error lines.
 */
export async function denyPendingConnectionRequests(
  baseUrl: string,
  answered: Set<string>
): Promise<{ records: ConnectionRequestAnswerRecord[]; errors: string[] }> {
  const records: ConnectionRequestAnswerRecord[] = [];
  const errors: string[] = [];
  let pending: Array<{ requestId?: unknown }>;
  try {
    const res = await fetch(`${baseUrl}${PENDING_CONNECTION_REQUESTS_PATH}`);
    if (!res.ok) return { records, errors: [`GET agent requests returned ${res.status}`] };
    const body = (await res.json()) as { requests?: unknown };
    pending = Array.isArray(body.requests) ? (body.requests as Array<{ requestId?: unknown }>) : [];
  } catch (err) {
    return { records, errors: [`GET agent requests failed: ${message(err)}`] };
  }
  for (const request of pending) {
    const requestId = typeof request.requestId === 'string' ? request.requestId : undefined;
    if (!requestId || answered.has(requestId)) continue;
    answered.add(requestId);
    try {
      const res = await fetch(
        `${baseUrl}/api/connectors/agent-requests/${encodeURIComponent(requestId)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'denied' }),
        }
      );
      records.push({
        requestId,
        decision: 'denied',
        decidedAt: new Date().toISOString(),
        status: res.status,
      });
      if (!res.ok) errors.push(`deny of connection request ${requestId} returned ${res.status}`);
    } catch (err) {
      errors.push(`deny of connection request ${requestId} failed: ${message(err)}`);
    }
  }
  return { records, errors };
}

/** One-line description of an unknown thrown value. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
