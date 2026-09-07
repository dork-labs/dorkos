/**
 * Exact Composio hosted-client construction boundary.
 *
 * Raw project keys are hashed only inside the confined provider package. The
 * returned digest is server-internal evidence for the precise clients and
 * custom-auth configuration used by one material generation.
 *
 * @module connector-providers/composio/hosted-client-factory
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';

import { ComposioManagedAccountClient } from './managed-account-client.js';
import { ComposioSdkClient } from './sdk-client.js';

/** Exact trusted material used to construct one hosted Composio generation. */
export interface ComposioHostedClientMaterial {
  /** Verified project API key. Never returned or logged. */
  apiKey: string;
  /** Tenant-derived provider user id. */
  serverUserId: string;
  /** Server-owned toolkit-to-custom-auth configuration map. */
  authConfigByToolkit: Readonly<Record<string, string>>;
  /** Optional fixed API origin used by hermetic tests. */
  baseUrl?: string;
}

/** Exact hosted clients plus an opaque digest of their construction material. */
export interface ComposioHostedClients {
  /** Exact-version discovery and execution client. */
  operations: ComposioSdkClient;
  /** Exact-account authentication and inventory client. */
  accounts: ComposioManagedAccountClient;
  /** Server-internal digest; never a capability or public DTO. */
  executionConfigDigest: string;
}

/** Construct both hosted clients once and digest those same trusted values. */
export function createComposioHostedClients(
  material: ComposioHostedClientMaterial
): ComposioHostedClients {
  const digestInput = {
    apiKey: material.apiKey,
    serverUserId: material.serverUserId,
    authConfigByToolkit: Object.fromEntries(
      Object.entries(material.authConfigByToolkit).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    baseUrl: material.baseUrl ?? 'https://backend.composio.dev',
  };
  const executionConfigDigest = createHash('sha256')
    .update(stableStringify(digestInput))
    .digest('hex');
  const common = {
    apiKey: material.apiKey,
    ...(material.baseUrl && { baseUrl: material.baseUrl }),
  };
  return {
    operations: new ComposioSdkClient({ ...common, serverUserId: material.serverUserId }),
    accounts: new ComposioManagedAccountClient(common),
    executionConfigDigest,
  };
}
