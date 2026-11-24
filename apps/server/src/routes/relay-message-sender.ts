/**
 * Who a relay message sent over HTTP is from, set by the server
 * (`POST /api/relay/messages`, DOR-5151).
 *
 * The caller is read with the sessions route's own rule ({@link sessionLauncherOf}),
 * so "the person" means the same thing on both routes:
 *
 * - **The person's own turn** sends from the address they name, and its
 *   payload may shape the turn as a bound chat's does.
 * - **An agent whose token verified** sends from its own address in the
 *   registry, or `relay.external.http` when the registry does not know it,
 *   and its message carries the limits its running turns hold
 *   ({@link launcherTurnCeiling}), exactly as a chat it starts there does.
 * - **Anyone else** sends from `relay.external.http`, held like that agent.
 *
 * Only the person sends from a person's address: anyone else naming one is
 * refused, and the app's window without a session is then asked for the
 * password by the chain (`http/person-session-refusal.ts`). A message that is
 * not the person's never shapes the turn it starts: its folder, agent, mode
 * and word fields are dropped. The limits field is the server's alone, so a
 * caller's copy of it is always dropped.
 *
 * @module routes/relay-message-sender
 */
import { CARRIED_TURN_LIMITS_FIELD, TURN_SHAPING_PAYLOAD_FIELDS } from '@dorkos/relay';
import type { RelaySendMessageRequest } from '@dorkos/shared/relay-schemas';
import type { RequestFacts } from '../http/request-facts.js';
import { launcherTurnCeiling, sessionLauncherOf } from './session-launcher.js';

/** The sender of a relay message from a caller DorkOS cannot name. */
export const HTTP_RELAY_SENDER = 'relay.external.http';

/** Why a caller other than the person may not send from a person's address. */
export const PERSON_SENDER_REFUSAL =
  "Only you can send from a person's address. Send from your own instead.";

/** Looks up the relay address of the agent at a home, when the registry knows it. */
export type AgentSubjectLookup = (agentPath: string) => string | undefined;

/** What the route sends: who from, and the payload, or why it refuses. */
export type RelayMessageSend =
  { refused: { error: string; code: 'person_required' } } | { from: string; payload: unknown };

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A payload without the named fields; anything but an object is kept as it is. */
function without(payload: unknown, fields: readonly string[]): unknown {
  if (!isRecord(payload)) return payload;
  const kept = { ...payload };
  for (const field of fields) delete kept[field];
  return kept;
}

/** A non-object payload as words, so the limits it carries have somewhere to ride. */
function asObject(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) return payload;
  return { content: typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? '') };
}

/**
 * Who this message is from, and what it carries, as the route sends it.
 *
 * @param facts - The request's facts.
 * @param data - The validated request body.
 * @param agentSubjectOf - The registry lookup for an agent's own address.
 */
export function relayMessageSender(
  facts: RequestFacts,
  data: Pick<RelaySendMessageRequest, 'from' | 'payload'>,
  agentSubjectOf?: AgentSubjectLookup
): RelayMessageSend {
  const launcher = sessionLauncherOf(facts);
  if (launcher.kind === 'person') {
    return { from: data.from, payload: without(data.payload, [CARRIED_TURN_LIMITS_FIELD]) };
  }
  if (launcher.kind === 'unidentified' && data.from.startsWith('relay.human.')) {
    return { refused: { error: PERSON_SENDER_REFUSAL, code: 'person_required' } };
  }
  const from =
    (launcher.kind === 'agent' ? agentSubjectOf?.(launcher.agentPath) : undefined) ??
    HTTP_RELAY_SENDER;
  const payload = without(data.payload, [
    ...TURN_SHAPING_PAYLOAD_FIELDS,
    CARRIED_TURN_LIMITS_FIELD,
  ]);
  const limits = launcherTurnCeiling(launcher, facts);
  if (limits.permissionCeiling === undefined && limits.carriedMarks === undefined) {
    return { from, payload };
  }
  return { from, payload: { ...asObject(payload), [CARRIED_TURN_LIMITS_FIELD]: limits } };
}
