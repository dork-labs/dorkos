/**
 * What a `start_turn` effect keeps beside its run (spec `turns-survive-restarts`
 * §6.1): the caller's turn options that are not a record column, so the
 * handler can build the computer face's request after a restart. References,
 * settings and DorkOS copy only: the words stay where their caller keeps them
 * (`turn-port.ts`), and who the turn is for, what started it, who asked and
 * its deadline are the run's own columns.
 *
 * @module services/runs/effects/start-payload
 */
import { z } from 'zod';
import { StartTurnInputSchema, type StartTurnInput } from '@dorkos/shared/turn-port';

const fields = StartTurnInputSchema.shape;

/** The payload, parsed with the port's own field schemas. */
export const StartPayloadSchema = z.strictObject({
  cwd: fields.cwd,
  tier: fields.tier,
  originRef: fields.originRef,
  permissionCeiling: fields.permissionCeiling,
  systemPromptAppend: fields.systemPromptAppend,
  additionalDirectories: fields.additionalDirectories,
  prepare: fields.prepare,
  settings: fields.settings,
  seedContext: fields.seedContext,
  accountHint: fields.accountHint,
});

/** A `start_turn` effect's payload. See {@link StartPayloadSchema}. */
export type StartPayload = z.infer<typeof StartPayloadSchema>;

/**
 * The payload a start saves: every turn option the run's columns do not hold.
 *
 * @param start - The parsed start.
 */
export function startPayloadOf(start: StartTurnInput): StartPayload {
  const {
    sessionId: _sessionId,
    agentId: _agentId,
    content: _content,
    origin: _origin,
    askedByRef: _askedByRef,
    sourceRef: _sourceRef,
    notAfter: _notAfter,
    ...payload
  } = start;
  return payload;
}
