/** Private provider event capability. Secrets and vendor bindings never enter public DTOs. */
import type { ConnectorEventDefinition } from './connector-event-schemas.js';

/** Bounded exact-version discovery request; signal belongs to the server. */
export interface ConnectorEventPageRequest {
  toolkit: string;
  toolkitVersion: string;
  cursor?: string;
  limit: number;
  signal: AbortSignal;
}
/** Live server-owned dispatch check, consulted after asynchronous preflight. */
export interface ConnectorEventMutationAuthority {
  signal: AbortSignal;
  authorizeDispatch: () => boolean | Promise<boolean>;
}
/** Exact private physical trigger scope; identical logical subscribers may share it. */
export interface ConnectorPhysicalTriggerScope {
  externalAccountRef: string;
  definition: ConnectorEventDefinition;
  filter: Record<string, unknown>;
}
/** An exact registered vendor identity pair, retained privately for V1/V2 verification. */
export interface ConnectorPhysicalTrigger {
  providerTriggerRef: string;
  providerTriggerUuid?: string;
  externalAccountRef: string;
  externalAccountUuid?: string;
  enabled: boolean;
}
/** Mutations never assert that a vendor timeout means no effect happened. */
export type ConnectorEventMutationResult =
  | { status: 'ok' }
  | { status: 'denied'; code: 'AUTHORITY_CHANGED' | 'CANCELLED' }
  | { status: 'error'; code: 'PROVIDER_PRECHECK_FAILED' }
  | { status: 'outcome_unknown'; code: 'PROVIDER_OUTCOME_UNKNOWN' };
/** Verified envelope identity; raw event content still requires minimization and protection. */
export interface ConnectorVerifiedEvent {
  authenticatedWebhookId: string;
  envelopeVersion: 'V1' | 'V2';
  providerTriggerRef: string;
  providerTriggerUuid?: string;
  externalAccountRef: string;
  externalAccountUuid?: string;
  providerUserRef?: string;
  eventType: string;
  payload: Record<string, unknown>;
}
/** Raw signed request passed to a configured verifier; no caller-selected secret or tolerance. */
export interface ConnectorRawWebhook {
  rawBody: Uint8Array;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
}
/** Optional provider capability; absence is explicitly unsupported. */
export interface ConnectorEventCapability {
  listDefinitions(request: ConnectorEventPageRequest): Promise<{
    status: 'ok';
    definitions: Array<ConnectorEventDefinition & { providerDefinitionRef?: string }>;
    nextCursor?: string;
  }>;
  /** Read all bounded exact-scope matches; absent and ambiguous are distinct. */
  reconcileTrigger(
    input: ConnectorPhysicalTriggerScope & { signal: AbortSignal }
  ): Promise<
    | { status: 'found'; trigger: ConnectorPhysicalTrigger }
    | { status: 'absent' | 'ambiguous' | 'unavailable' }
  >;
  /** Upsert does not prove DorkOS created or exclusively owns the returned trigger. */
  createTrigger(
    input: ConnectorPhysicalTriggerScope & ConnectorEventMutationAuthority
  ): Promise<
    | { status: 'ready'; providerTriggerRef: string; ownership: 'unproven' }
    | Exclude<ConnectorEventMutationResult, { status: 'ok' }>
  >;
  /** Status only. Filter edits require a reference-safe replacement saga. */
  setTriggerEnabled(
    input: ConnectorEventMutationAuthority & {
      providerTriggerRef: string;
      enabled: boolean;
    }
  ): Promise<ConnectorEventMutationResult>;
  /** Caller must establish exclusive ownership or explicit management consent before invoking. */
  deleteTrigger(
    input: ConnectorEventMutationAuthority & {
      providerTriggerRef: string;
    }
  ): Promise<ConnectorEventMutationResult>;
  verifyWebhook(
    input: ConnectorRawWebhook
  ): Promise<
    { status: 'verified'; event: ConnectorVerifiedEvent } | { status: 'rejected'; code: string }
  >;
}
