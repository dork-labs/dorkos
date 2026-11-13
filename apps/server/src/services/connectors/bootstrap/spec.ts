import type { ConnectorProvider, ConnectorCustody } from '@dorkos/shared/connector-provider';

/** One credential-gated provider the bootstrapper owns end to end. */
export interface ManagedProviderSpec {
  /** The backend type (= the `:provider` route segment). */
  type: string;
  /** Exact default instance owned by this legacy type-scoped configuration. */
  defaultInstanceId: ConnectorProvider['instanceId'];
  /** The log label boot/reload messages use, e.g. `'Composio managed backend'`. */
  logLabel: string;
  /** Custody stance echoed onto the status DTO. */
  custody: ConnectorCustody;
  /** The credential-store NAME (not the `file:` ref) the routes write/delete. */
  credentialName: string;
  /** Whether the provider counts as configured (credential + any required env). */
  configured(): Promise<boolean>;
  /** Run the provider factory; `null` = unconfigured, may throw a refusal. */
  create(): Promise<ConnectorProvider | null>;
  /** Whether a thrown factory error is a log-and-skip refusal (vs a genuine bug). */
  isRefusal(err: unknown): boolean;
}
