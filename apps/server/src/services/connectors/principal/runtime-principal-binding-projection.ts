import { connectorRuntimeBindings, eq, type Db } from '@dorkos/db';
import type { readOriginalRoomEmissionRuntimeBindingRow } from '../../canvas/doc-channel/operations/room-responder-operation.js';
type RuntimeBindingRow = typeof connectorRuntimeBindings.$inferSelect;

/** Pure spelling projection of the original native emission SQL row; it issues no authority. */
export function projectOriginalEmissionBindingRow(
  raw: ReturnType<typeof readOriginalRoomEmissionRuntimeBindingRow>
): RuntimeBindingRow | undefined {
  return raw
    ? ({
        id: raw.id,
        tokenHash: raw.token_hash,
        bootEpoch: raw.boot_epoch,
        ownerKind: raw.owner_kind,
        ownerId: raw.owner_id,
        runtime: raw.runtime,
        canonicalSessionId: raw.canonical_session_id,
        agentId: raw.agent_id,
        agentPath: raw.agent_path,
        canonicalCwd: raw.canonical_cwd,
        createdAt: raw.created_at,
        expiresAt: raw.expires_at,
        revokedAt: raw.revoked_at,
        revokeReason: raw.revoke_reason,
      } as RuntimeBindingRow)
    : undefined;
}

/** Read one durable binding row; caller must perform its original private currentness and authority gates. */
export function readRuntimePrincipalBindingRow(
  db: Db,
  bindingId: string
): RuntimeBindingRow | undefined {
  return db
    .select()
    .from(connectorRuntimeBindings)
    .where(eq(connectorRuntimeBindings.id, bindingId))
    .get();
}

/**
 * Classify existing binding DATA without issuing a principal or changing durable/process state.
 * The original clock is called only after the original boot/revocation short circuits.
 */
export function projectRuntimeBindingRefusal(
  row: RuntimeBindingRow,
  bootEpoch: string | undefined,
  revokedBindingIds: ReadonlySet<string>,
  now: () => Date
): 'revoked' | 'stale_boot' | 'expired' | undefined {
  if (!bootEpoch || row.bootEpoch !== bootEpoch) return 'stale_boot';
  if (revokedBindingIds.has(row.id) || row.revokedAt) return 'revoked';
  if (Date.parse(row.expiresAt) <= now().getTime()) return 'expired';
  return undefined;
}

/** Compare durable binding target DATA in the original runtime-then-cwd order. */
export function projectRuntimeBindingTargetRefusal(
  row: typeof connectorRuntimeBindings.$inferSelect,
  input: import('../runtime-principal-port.js').ResolveConnectorTurnInput
): 'wrong_runtime' | 'wrong_cwd' | undefined {
  if (row.runtime !== input.expectedRuntime) return 'wrong_runtime';
  if ((row.canonicalCwd ?? undefined) !== input.expectedCanonicalCwd) return 'wrong_cwd';
  return undefined;
}

/** Compare thread-key target DATA without normalizing its original cwd value. */
export function projectRuntimeThreadTargetRefusal(
  scope: import('../runtime-principal-port.js').ConnectorThreadKeyScope,
  input: import('../runtime-principal-port.js').ResolveConnectorTurnInput
): 'wrong_runtime' | 'wrong_cwd' | undefined {
  if (scope.runtime !== input.expectedRuntime) return 'wrong_runtime';
  if (scope.canonicalCwd !== input.expectedCanonicalCwd) return 'wrong_cwd';
  return undefined;
}
