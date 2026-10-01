/** Internal verified-access port; never deserialize these fields from a page envelope. */
import type { DbTransaction } from '@dorkos/db';
import type {
  CanvasChannelRoute,
  CanvasChannelJsonValue,
} from '@dorkos/shared/canvas-channel-schemas';

/** Current server-derived route decision, including saved-but-unapproved outcomes. */
export interface DocRouteDecision {
  route: CanvasChannelRoute;
  grantId?: string;
  grantRevision?: number;
  reason?: string;
}

/** Resolved access returned by the parent authority service inside the final write transaction. */
export interface DocIngestAccess {
  documentId: string;
  scope: string;
  documentLabel: string;
  provenance: CanvasChannelJsonValue;
  routes: DocRouteDecision[];
  envelopeBytes?: number;
  eventsPerMinute?: number;
  /** Validate declared payloads without allowing an app manifest to grant routing authority. */
  validatePayload?(type: string, payload: CanvasChannelJsonValue): undefined;
}

/** Required synchronous callback rechecks current identity, closure and authority before any mutation. */
export type DocIngestAuthority = (tx: DbTransaction) => DocIngestAccess;

/** Refusal with stable public status, without accepted input or sensitive payload in diagnostics. */
export class DocIngestRefusal extends Error {
  /** Build a typed refusal suitable for a later thin HTTP wrapper. */
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = 'DocIngestRefusal';
  }
}
