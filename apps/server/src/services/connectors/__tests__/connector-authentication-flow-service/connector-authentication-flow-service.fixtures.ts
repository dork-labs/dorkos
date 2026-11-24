/**
 * The restart-safe provider, seed rows and per-test harness for the ConnectorAuthenticationFlowService tests.
 */
import { beforeEach, vi } from 'vitest';
import { connections, createDb, runMigrations, type Db } from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { type ConnectPoll, type ConnectStart } from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorAuthenticationFlowService } from '../../resources/authentication-flow-service.js';
import { ConnectorLifecycleService } from '../../resources/lifecycle-service.js';
import { ConnectorRegistry } from '../../registry.js';

export const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

export const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;

export const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');

/** The provider and app every sign-in here starts against. */
export const GMAIL_START = { providerInstanceId: PROVIDER_ID, toolkit: 'gmail' } as const;

export const NOW = new Date('2026-09-06T18:00:00.000Z');

export class RestartSafeProvider extends FakeConnectorProvider {
  /** Start a provider flow whose handle is independently pollable after restart. */
  override startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    return Promise.resolve({
      flowId: `provider-flow:${toolkit}:${opts?.label ?? 'default'}`,
      authorizeUrl: 'https://provider.example/authorize',
    });
  }

  /** Resolve solely from the provider-private handle, without process memory. */
  override pollConnect(flowId: string): Promise<ConnectPoll> {
    const [, toolkit, label] = flowId.split(':');
    return Promise.resolve({
      status: 'connected',
      account: {
        externalAccountRef: `external:${toolkit}:${label}` as never,
        toolkit: toolkit!,
        label: label!,
        status: 'active',
        custody: 'managed',
      },
    });
  }
}

export function insertActiveConnection(db: Db, connectionId = 'connection-existing') {
  const id = ConnectionIdSchema.parse(connectionId);
  db.insert(connections)
    .values({
      id,
      providerInstanceId: PROVIDER_ID,
      externalAccountRef: 'external:gmail:Original',
      toolkit: 'gmail',
      label: 'Original',
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  return id;
}

/** The shared per-test state and helpers every connector-authentication-flow-service piece uses. */
export function useAuthenticationFlowHarness() {
  const h = {
    db: undefined as unknown as Db,
    registry: undefined as unknown as ConnectorRegistry,
    provider: undefined as unknown as RestartSafeProvider,
    service: undefined as unknown as ConnectorAuthenticationFlowService,
  };

  beforeEach(() => {
    h.db = createDb(':memory:');
    runMigrations(h.db);
    h.registry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    h.provider = new RestartSafeProvider({ instanceId: PROVIDER_ID });
    h.registry.register(h.provider, 'material-a');
    h.service = new ConnectorAuthenticationFlowService({
      db: h.db,
      registry: h.registry,
      now: () => NOW,
    });
  });

  return h;
}

/** A lifecycle service over the harness's flows, with authority cleanup stubbed out. */
export function lifecycleFor(h: ReturnType<typeof useAuthenticationFlowHarness>) {
  return new ConnectorLifecycleService({
    db: h.db,
    registry: h.registry,
    authenticationFlows: h.service,
    authorityCleanup: {
      revokeConnection: vi.fn(),
      revokeAgent: vi.fn(),
      revokeAgentConnection: vi.fn(),
    },
  });
}
