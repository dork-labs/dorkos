/**
 * What the connector preflight hands the permission gate about one connected-app call: whether
 * it reaches people outside the team (DOR-3683), and the class, connection and person's
 * writes-back switch a same-source write is decided on (DOR-4794, `should-ask.ts`).
 *
 * @module services/core/prompts/connector-gate-facts
 */
import type { CapabilityPreflightResult } from '../capabilities/registry.js';

/** What the connector preflight read about one call, for the same-source prompt kind. */
export interface SameSourceWrite {
  /** The connection the preflight authorized; read from the authority binding, never set. */
  readonly connectionId: string;
  /** The app the authorized action belongs to, e.g. `linear`, from the stored revision. */
  readonly toolkit: string;
  /** The stored class of the exact action revision. Only `write` can skip the card. */
  readonly classification: 'read' | 'write' | 'destructive';
  /** Whether the person turned writes back on for this connection. */
  readonly writesBackUnasked: boolean;
}

// The connector preflight's own field, declared beside the facts that read it. Built by
// `connectors/execution/reaches-outside.ts` from the stored records it just checked.
declare module '../capabilities/registry.js' {
  interface CapabilityPreflightResult {
    /** The class and the person's writes-back switch, read by the preflight (DOR-4794). */
    readonly sameSource?: Omit<SameSourceWrite, 'connectionId'>;
  }
}

/** The connector preflight's facts the permission gate reads for one call. */
export interface ConnectorGateFacts {
  /**
   * False when the connector preflight read this call as one that reaches nobody outside the
   * team and can be undone (a draft, a label). Anything else counts as outward (DOR-3683).
   */
  outward?: boolean;
  /** The class, connection and writes-back switch of a connected-app call (DOR-4794). */
  sameSource?: SameSourceWrite;
}

/**
 * The gate facts a connector preflight carries, for `resolveCallPermission`. The connection is
 * read from the preflight's authority binding, which the registry has already checked was minted
 * by the authorization service, so no field a preflight sets can name a different account.
 *
 * @param preflight - The registry's live preflight result, when the capability has one.
 */
export function connectorGateFacts(
  preflight: CapabilityPreflightResult | undefined
): ConnectorGateFacts {
  if (!preflight) return {};
  const { sameSource } = preflight;
  return {
    ...(preflight.outward === false ? { outward: false } : {}),
    ...(sameSource
      ? {
          sameSource: {
            connectionId: preflight.authorityBinding.approvalScope.connectionId,
            toolkit: sameSource.toolkit,
            classification: sameSource.classification,
            writesBackUnasked: sameSource.writesBackUnasked,
          },
        }
      : {}),
  };
}
