/**
 * Answers from Wi-Fi into a turn that runs above Default (DOR-3037).
 *
 * A turn a person started at this computer runs at the agent's own level, and
 * answering its question is a message into that turn. From Wi-Fi, where a
 * message of one's own would be held to the runtime's default, an answer to
 * such a turn may only pick among what it offered: a question's option labels,
 * an elicitation's offered values (`enum`, `const`, `oneOf`, `anyOf`), yes or no. Typed words, and the reason a
 * Deny may carry, are refused there with {@link WIFI_FREE_TEXT_REFUSAL}. A turn
 * already held to the default takes any answer, as it would a message, and so
 * does every turn from the owner's own sign-in, whose words are not held
 * (DOR-3242, `wifiTurnHeld`).
 *
 * @module routes/session-answer-wifi
 */
import type { PendingInteractionDTO } from '@dorkos/shared/schemas';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { isNoLooserThan, resolveCeilingLevel } from '@dorkos/shared/permission-semantics';
import type { RequestFacts } from '../http/request-facts.js';
import { NOT_FROM_WIFI } from '../services/core/auth/sessions/wifi-level.js';
import { wifiTurnHeld } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { lastTurnLevelOf } from '../services/core/turn-power/turn-levels.js';
import { peekProjector } from '../services/session/session-state-projector.js';

/** What a Wi-Fi sign-in reads when it types into a turn above Default. */
export const WIFI_FREE_TEXT_REFUSAL =
  'This chat runs above Default. From Wi-Fi, pick an offered answer.';

/** What a Wi-Fi sign-in reads when it denies an agent's request with a reason. */
export const WIFI_DENY_REASON_REFUSAL =
  'From Wi-Fi, deny without a reason. Add one at this computer.';

/** The refusal body. */
type Refusal = { error: string; code: typeof NOT_FROM_WIFI };

/**
 * Whether the session's running turn runs above the runtime's default, read
 * from the turn's own record. A turn with no record counts as above.
 */
function turnAboveDefault(runtime: AgentRuntime, sessionId: string): boolean {
  const internal = runtime.getInternalSessionId(sessionId);
  const level = lastTurnLevelOf(sessionId) ?? (internal ? lastTurnLevelOf(internal) : undefined);
  if (!level) return true;
  let held: TurnPermissionLevel;
  try {
    held = resolveCeilingLevel(runtime.getCapabilities().permissionModes, 'runtime-default');
  } catch {
    return true;
  }
  if (!isNoLooserThan(held, level)) return true;
  return level.auto === true && held.auto !== true && held.asks !== 'never';
}

/**
 * Whether the gate applies: a Wi-Fi request whose own message would be held
 * (not the owner's own, DOR-3242) into a turn above Default.
 */
function gated(facts: RequestFacts, runtime: AgentRuntime, sessionId: string): boolean {
  return wifiTurnHeld(facts) && turnAboveDefault(runtime, sessionId);
}

/** The pending interaction with this id, when the session's projector has one. */
function pendingOf(sessionId: string, id: string): PendingInteractionDTO | undefined {
  return peekProjector(sessionId)
    ?.getPendingInteractions()
    .find((interaction) => interaction.id === id);
}

/**
 * The refusal for question answers from Wi-Fi that type words into a turn
 * above Default, or `undefined` when they may go on. A dismissal (no answers)
 * always may.
 *
 * @param facts - The request facts.
 * @param runtime - The session's runtime.
 * @param sessionId - The session.
 * @param toolCallId - The question's id.
 * @param answers - Each question's index to its picked label(s), joined by `, `.
 */
export function refuseTypedAnswers(
  facts: RequestFacts,
  runtime: AgentRuntime,
  sessionId: string,
  toolCallId: string,
  answers: Record<string, string>
): Refusal | undefined {
  if (Object.keys(answers).length === 0 || !gated(facts, runtime, sessionId)) return undefined;
  const pending = pendingOf(sessionId, toolCallId);
  const picksOnly =
    pending?.type === 'question' &&
    Object.entries(answers).every(([index, value]) => {
      const question = pending.questions[Number(index)];
      if (!question) return false;
      const labels = new Set(question.options.map((option) => option.label));
      const picked = question.multiSelect ? value.split(', ') : [value];
      return picked.every((label) => labels.has(label));
    });
  return picksOnly ? undefined : { error: WIFI_FREE_TEXT_REFUSAL, code: NOT_FROM_WIFI };
}

/** A field's offered values: its `enum`, or the `const` of each `oneOf` / `anyOf` option. */
function offered(field: unknown): unknown[] {
  const schema = (field ?? {}) as {
    const?: unknown;
    enum?: unknown[];
    oneOf?: { const?: unknown }[];
    anyOf?: { const?: unknown }[];
  };
  const options = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].map((option) => option.const);
  return [...(schema.enum ?? []), ...('const' in schema ? [schema.const] : []), ...options].filter(
    (value) => value !== undefined
  );
}

/** Whether one elicitation value is a pick: a yes or no, a number, or an offered value. */
function isPick(value: unknown, field: unknown): boolean {
  if (typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return offered(field).includes(value);
  const items = ((field ?? {}) as { items?: unknown }).items;
  if (Array.isArray(value)) return value.every((item) => offered(items).includes(item));
  return false;
}

/**
 * The refusal for an elicitation answer from Wi-Fi that types words into a
 * turn above Default, or `undefined` when it may go on. Declining or
 * cancelling always may.
 *
 * @param facts - The request facts.
 * @param runtime - The session's runtime.
 * @param sessionId - The session.
 * @param interactionId - The elicitation's id.
 * @param action - `accept`, `decline` or `cancel`.
 * @param content - The accepted form's values.
 */
export function refuseTypedElicitation(
  facts: RequestFacts,
  runtime: AgentRuntime,
  sessionId: string,
  interactionId: string,
  action: string,
  content: Record<string, unknown> | undefined
): Refusal | undefined {
  if (action !== 'accept' || !content || Object.keys(content).length === 0) return undefined;
  if (!gated(facts, runtime, sessionId)) return undefined;
  const pending = pendingOf(sessionId, interactionId);
  const properties =
    pending?.type === 'elicitation'
      ? ((pending.requestedSchema?.properties ?? {}) as Record<string, unknown>)
      : undefined;
  const picksOnly =
    properties !== undefined &&
    Object.entries(content).every(([key, value]) => isPick(value, properties[key]));
  return picksOnly ? undefined : { error: WIFI_FREE_TEXT_REFUSAL, code: NOT_FROM_WIFI };
}

/**
 * The refusal for a Deny from Wi-Fi that carries a reason into a turn above
 * Default: the reason is words the agent reads. A Deny with no reason may go on.
 *
 * @param facts - The request facts.
 * @param runtime - The session's runtime.
 * @param sessionId - The session.
 * @param denyReason - The reason, when one was typed.
 */
export function refuseDenyReason(
  facts: RequestFacts,
  runtime: AgentRuntime,
  sessionId: string,
  denyReason: string | undefined
): Refusal | undefined {
  if (!denyReason?.trim() || !gated(facts, runtime, sessionId)) return undefined;
  return { error: WIFI_FREE_TEXT_REFUSAL, code: NOT_FROM_WIFI };
}
