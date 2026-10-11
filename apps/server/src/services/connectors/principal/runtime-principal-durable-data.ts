import { and, connectorRuntimeBindings, eq, isNull, type Db } from '@dorkos/db';
import type {
  ConnectorTurnRenewalPermit,
  ConnectorTurnOwnership,
  RevokeConnectorTurnReason,
} from '../runtime-principal-port.js';

/** Data held by the original principal service's private renewal-owner map. */
export interface RuntimeRenewalOwner {
  readonly permit: ConnectorTurnRenewalPermit;
  readonly ownership: ConnectorTurnOwnership;
}

/** Durable boot revocation; the service retains its clock and process-local fences. */
export function revokePriorBootBindings(db: Db, now: string): void {
  db.update(connectorRuntimeBindings)
    .set({ revokedAt: now, revokeReason: 'server_restart' })
    .where(isNull(connectorRuntimeBindings.revokedAt))
    .run();
}

/** Durable revoke after the original service has installed both private deny fences. */
export function revokeRuntimeBindingRow(
  db: Db,
  bindingId: string,
  reason: RevokeConnectorTurnReason | 'authority_changed',
  now: () => Date
): void {
  db.update(connectorRuntimeBindings)
    .set({ revokedAt: now().toISOString(), revokeReason: reason })
    .where(
      and(eq(connectorRuntimeBindings.id, bindingId), isNull(connectorRuntimeBindings.revokedAt))
    )
    .run();
}
