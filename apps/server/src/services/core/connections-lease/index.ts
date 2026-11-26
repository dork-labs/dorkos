/**
 * The Connections lease: the types a runtime uses to open, renew and close the
 * per-turn connection principal, and the shape of that principal.
 *
 * Both sides import these. They hold live objects (an event queue, an abort
 * signal), so they are kernel types rather than shared contracts. The lease's
 * plain values (its two refusals and the service catalog's tool name) are in
 * `@dorkos/shared/connections-lease`. Minting a principal, the per-turn bearer
 * and its permit stay on the space side, in `services/connectors/principal/`.
 *
 * @module services/core/connections-lease
 */
export type {
  ConnectorOwnerAuthority,
  ConnectorRuntime,
  ServerPrincipalClaims,
  ServerPrincipalProof,
} from './principal-types.js';
export type {
  ConnectorRuntimeBindingBootPort,
  ConnectorRuntimePrincipalPort,
  ConnectorThreadKeyPort,
  ConnectorThreadKeyScope,
  ConnectorTurnOwnership,
  ConnectorTurnRefusalReason,
  ConnectorTurnRenewalPermit,
  MintedConnectorThreadKey,
  OpenConnectorTurnInput,
  OpenConnectorTurnResult,
  RenewConnectorTurnInput,
  RenewConnectorTurnResult,
  ResolveConnectorTurnInput,
  ResolveConnectorTurnResult,
  RevokeConnectorThreadKeyReason,
  RevokeConnectorTurnReason,
  RuntimeToolCaller,
  RuntimeToolTurnFacts,
  ThreadKeyToolListing,
} from './runtime-principal-port.js';
