/**
 * The turn-context record (spec "Agent context viewer + session timeline",
 * phase 1): what every turn actually handed its runtime, stored per turn and
 * private to the person. This barrel installs it, keeps it with its session
 * across a canonical-id rename, and exposes the one write every adapter makes.
 *
 * @module services/session/turn-context
 */
import type { Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { onDurableSessionRekey } from '../turn-identity/durable-rekey.js';
import {
  getTurnContextStore,
  setTurnContextStore,
  sweepExpiredTurnContext,
} from './record-turn-context.js';
import { secretValuesFromEnv } from './turn-context-redaction.js';
import { TurnContextStore } from './turn-context-store.js';

export {
  deleteTurnContextForSessions,
  getTurnContextStore,
  recordTurnContext,
  setTurnContextStore,
  sweepExpiredTurnContext,
  turnPlaceOf,
} from './record-turn-context.js';
export {
  TURN_CONTEXT_RETENTION_MS,
  TurnContextStore,
  type RecordedTurnContext,
  type RecordedTurnContextPart,
  type TurnContextInput,
  type TurnContextPartInput,
  type TurnContextPlace,
} from './turn-context-store.js';

/**
 * Install the record over the database, and sweep out text past its 30 days.
 * Called once at startup, before any runtime takes a turn.
 *
 * Every record is swept for the keys in the environment and for the secrets
 * the space side hands in (the local `/mcp` token, which the space side mints
 * and this side never reads itself).
 *
 * @param db - The DorkOS database.
 * @param handedSecrets - The live secret values the space side holds, read per record.
 *   Required, so a boot path that installs the record always says what it sweeps for.
 * @returns The installed store.
 */
export function installTurnContextStore(
  db: Db,
  handedSecrets: () => readonly string[]
): TurnContextStore {
  const knownSecrets = () => [...secretValuesFromEnv(), ...handedSecrets()];
  const store = new TurnContextStore(db, { knownSecrets });
  setTurnContextStore(store);
  sweepExpiredTurnContext();
  return store;
}

// A first turn's request id gives way to the runtime's canonical one; the
// record follows it, like every other durable per-session row.
onDurableSessionRekey((fromId, toId) => {
  try {
    getTurnContextStore()?.rekeySession(fromId, toId);
  } catch (err) {
    // A record left under the old id is lost to its viewer, not to the turn.
    logger.warn('[TurnContext] could not move a session’s records to its new id', {
      fromId,
      toId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
