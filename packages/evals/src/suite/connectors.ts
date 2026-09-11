/**
 * The connectors suite — the two W4 connector evals (connector-gateway spec
 * §Testing Strategy G5, `plans/shapes-program.md` W4) expressed against the
 * `ConnectorProvider` interface with FAKES, never live credentials:
 *
 * - **`connector-gmail`** ("Connect to my Gmail") drives the gateway path:
 *   `recommendConnector('gmail')` tops with a gateway; two connects of one
 *   toolkit yield two distinct, independently-addressable accounts; outward
 *   connection DTOs carry no provider-private account reference; and the refined eval-13 oracle
 *   holds — the only persisted credential
 *   reference on the managed path is the vendor API-key ref, never a per-account
 *   token ref.
 * - **`connector-slack`** ("Connect to Slack") is the discriminating routing
 *   eval: `recommendConnector('slack')` tops with the purpose-built relay
 *   adapter, ranked ABOVE any generic gateway.
 *
 * WHY FAKE-BACKED AND STRUCTURAL: these prove the two evals are EXPRESSIBLE
 * against the spec'd interface and hold as a deterministic contract. Their
 * oracles exercise the real `recommendConnector` / `ConnectorRegistry` /
 * canonical owner resource projection / Composio-provider code with a
 * {@link @dorkos/test-utils!FakeConnectorProvider} and an in-memory Composio
 * client, so they run on `test-mode` (no model, no key, free) and gate nothing
 * they cannot deterministically prove.
 *
 * WHY STILL `quarantined` (spec: "Quarantined until W5"): the LIVE promotion —
 * a real model driving owner-reviewed connect and brokered execution against a
 * mock OAuth provider (CI) or a real provider sandbox (weekly, D5) — is the W5
 * gate. Until that lands, these interface-contract cases are honest structural
 * proof and never claim the surface works end-to-end.
 *
 * @module evals/suite/connectors
 */
import { FakeConnectorProvider } from '@dorkos/test-utils/fake-connector-provider';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ConnectorRegistry,
  ConnectorOperatorQueryService,
  recommendConnector,
  maybeCreateComposioProvider,
  COMPOSIO_API_KEY_REF,
  type RelayAdapterCatalog,
  type CredentialProvider,
  type CredentialResolution,
  type ComposioHttpClient,
  type ComposioToolkitInfo,
  type ComposioConnectionRequest,
  type ComposioConnectionState,
  type ComposioConnectedAccount,
} from '@dorkos/server/services/connectors';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import type { EvalCase, Oracle, OracleResult } from '../types.js';

/** The service the gateway eval connects (multi-account by design). */
const GMAIL = 'gmail';
/** The service the routing eval discriminates (relay adapter beats the gateway). */
const SLACK = 'slack';
const OWNER = { kind: 'local_install', installationId: 'eval-install' } as const;
/** Build a relay adapter catalog exposing a purpose-built adapter for the given slugs. */
function relayWith(slugs: Record<string, string>): RelayAdapterCatalog {
  return {
    getManifest(type: string) {
      return slugs[type] ? { displayName: slugs[type] } : undefined;
    },
  };
}

/** Drive one connect flow on a fake provider to its connected account. */
async function connectOne(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  if (!account) throw new Error(`connect for '${label}' produced no account`);
  return registry.recordConnect(provider, account);
}

/** A gateway with two connected Gmail accounts, registered for routing + exposure. */
async function twoGmailAccounts(providerType: string): Promise<{
  db: ReturnType<typeof createTestDb>;
  registry: ConnectorRegistry;
  provider: FakeConnectorProvider;
  personal: ConnectedAccount;
  work: ConnectedAccount;
}> {
  const db = createTestDb();
  const registry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
  });
  const provider = new FakeConnectorProvider({
    type: providerType,
    custody: 'managed',
    supportsMultiAccount: true,
  });
  registry.register(provider);
  const personal = await connectOne(registry, provider, GMAIL, 'personal');
  const work = await connectOne(registry, provider, GMAIL, 'work');
  return { db, registry, provider, personal, work };
}

/** `recommendConnector('gmail')` must top with the gateway (no relay adapter for Gmail). */
const gmailRoutesToGateway: Oracle = async (): Promise<OracleResult> => {
  const registry = new ConnectorRegistry({ db: createTestDb() });
  registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
  const { recommendations } = await recommendConnector(GMAIL, {
    registry,
    relay: relayWith({ [SLACK]: 'Slack' }),
  });
  const top = recommendations[0];
  const passed =
    top?.kind === 'gateway' &&
    top.target === GMAIL &&
    top.provider === 'composio' &&
    !recommendations.some((r) => r.kind === 'relay-adapter');
  return {
    label: "recommendConnector('gmail') tops with the gateway, no relay adapter",
    passed,
    evidence: recommendations,
    ...(passed ? {} : { detail: `top was ${JSON.stringify(top)}` }),
  };
};

/** Two connects of Gmail yield two distinct stable, independently routable accounts. */
const gmailTwoAccountAddressing: Oracle = async (): Promise<OracleResult> => {
  const { registry, provider, personal, work } = await twoGmailAccounts('composio');
  const accounts = await provider.listAccounts({ toolkit: GMAIL });
  const personalRef = registry.accountBinding(personal.id)?.externalAccountRef;
  const workRef = registry.accountBinding(work.id)?.externalAccountRef;
  const passed =
    personal.id !== work.id &&
    accounts.length === 2 &&
    personalRef !== undefined &&
    workRef !== undefined &&
    personalRef !== workRef;
  return {
    label: 'two Gmail accounts have distinct stable ids and private provider bindings',
    passed,
    evidence: { ids: [personal.id, work.id], count: accounts.length },
    ...(passed ? {} : { detail: 'expected two distinct stable ids and provider bindings' }),
  };
};

/** Owner resource rows omit private provider account references. */
const gmailPublicRowsHideProviderIdentity: Oracle = async (): Promise<OracleResult> => {
  const { db } = await twoGmailAccounts('gateway-under-test');
  const query = new ConnectorOperatorQueryService({
    db,
    registry: new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    }),
    agentOwnership: { ownsAgent: () => false },
    sessions: { resolveSessionAgent: () => undefined },
  });
  const rows = await query.listConnections(OWNER);
  const passed =
    rows.length === 2 &&
    rows.every((row) => !('provider' in row) && !('externalAccountRef' in row));
  return {
    label: 'owner connection rows omit private provider account references',
    passed,
    evidence: rows,
    ...(passed ? {} : { detail: 'provider-private account identity crossed the owner resource' }),
  };
};

/**
 * The refined eval-13 oracle (connector-gateway spec §Testing Strategy;
 * `specs/eval-harness/02-specification.md:286`): on the managed gateway path the
 * ONLY persisted credential reference is the vendor API-key ref
 * ({@link COMPOSIO_API_KEY_REF}), never a per-account token ref — upstream OAuth
 * tokens live in the vendor vault and never touch DorkOS's credential store.
 */
const gmailPersistsOnlyVendorKeyRef: Oracle = async (): Promise<OracleResult> => {
  const resolveCalls: string[] = [];
  const credentials: CredentialProvider = {
    resolve(ref: string): Promise<CredentialResolution> {
      resolveCalls.push(ref);
      return Promise.resolve({ ok: true, secret: 'test-composio-key' });
    },
  };
  const provider = await maybeCreateComposioProvider({
    credentials,
    makeClient: () => new InMemoryComposioClient(),
  });
  if (!provider) {
    return {
      label: 'managed path resolves only the vendor API-key ref',
      passed: false,
      detail: 'provider was not created from the resolved key',
    };
  }
  // Drive two connects; the private per-account handles are opaque `ca_…` ids, NOT
  // credential references, and no further credential resolution happens.
  const first = await provider.startConnect(GMAIL, { label: 'personal' });
  const firstAccount = (await provider.pollConnect(first.flowId)).account;
  const second = await provider.startConnect(GMAIL, { label: 'work' });
  const secondAccount = (await provider.pollConnect(second.flowId)).account;

  const onlyVendorKeyResolved =
    resolveCalls.length === 1 && resolveCalls[0] === COMPOSIO_API_KEY_REF;
  const vendorRefIsNotAccountScoped =
    COMPOSIO_API_KEY_REF === 'file:composio-api-key' && !COMPOSIO_API_KEY_REF.includes('ca_');
  const accountsAreOpaqueHandles = Boolean(
    firstAccount?.externalAccountRef.includes('ca_') &&
    secondAccount?.externalAccountRef.includes('ca_') &&
    firstAccount.externalAccountRef !== secondAccount.externalAccountRef
  );
  const passed = onlyVendorKeyResolved && vendorRefIsNotAccountScoped && accountsAreOpaqueHandles;
  return {
    label: 'managed path resolves only the vendor API-key ref, never a per-account token ref',
    passed,
    evidence: {
      resolveCalls,
      accountIds: [firstAccount?.externalAccountRef, secondAccount?.externalAccountRef],
    },
    ...(passed ? {} : { detail: `resolveCalls=${JSON.stringify(resolveCalls)}` }),
  };
};

/** `recommendConnector('slack')` must top with the relay adapter, above any gateway. */
const slackRoutesToRelayAdapterFirst: Oracle = async (): Promise<OracleResult> => {
  const registry = new ConnectorRegistry({ db: createTestDb() });
  // A gateway that ALSO lists Slack, so the eval proves precedence, not absence.
  registry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
  const { recommendations } = await recommendConnector(SLACK, {
    registry,
    relay: relayWith({ [SLACK]: 'Slack' }),
  });
  const top = recommendations[0];
  const gateway = recommendations.find((r) => r.kind === 'gateway');
  const passed =
    top?.kind === 'relay-adapter' &&
    top.target === SLACK &&
    top.rank === 0 &&
    gateway !== undefined &&
    top.rank < gateway.rank;
  return {
    label: "recommendConnector('slack') tops with the relay adapter, above the gateway",
    passed,
    evidence: recommendations,
    ...(passed ? {} : { detail: `top was ${JSON.stringify(top)}` }),
  };
};

/**
 * `connector-gmail` — "Connect to my Gmail" against the gateway path, fake-backed.
 * Structural (no model) and quarantined until the W5 live promotion; see the
 * module doc for why. Every oracle is a deterministic interface-contract check.
 */
export const connectorGmailCase: EvalCase = {
  id: 'connector-gmail',
  title: 'Gmail interface contract — structural only, no chat or model',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['connector'],
  quarantined: true,
  oracles: [
    gmailRoutesToGateway,
    gmailTwoAccountAddressing,
    gmailPublicRowsHideProviderIdentity,
    gmailPersistsOnlyVendorKeyRef,
  ],
};

/**
 * `connector-slack` — "Connect to Slack" routes to the purpose-built relay
 * adapter, ahead of the generic gateway (the discriminating W4 routing eval).
 * Structural (no model) and quarantined until the W5 live promotion.
 */
export const connectorSlackCase: EvalCase = {
  id: 'connector-slack',
  title: 'Connect to Slack — routes to the relay adapter, ahead of the gateway',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['connector'],
  quarantined: true,
  oracles: [slackRoutesToRelayAdapterFirst],
};

/**
 * A minimal in-memory {@link ComposioHttpClient} for the eval — the fake
 * Composio cloud the managed provider is driven against, with no network and no
 * key. Mints `ca_…` handles and resolves each connect to ACTIVE on first poll.
 */
class InMemoryComposioClient implements ComposioHttpClient {
  private counter = 0;
  private readonly requests = new Map<string, { toolkit: string; alias?: string; caId?: string }>();
  private readonly accounts = new Map<string, ComposioConnectedAccount>();

  listToolkits(): Promise<ComposioToolkitInfo[]> {
    return Promise.resolve([
      { slug: GMAIL, name: 'Gmail', authScheme: 'OAUTH2' },
      { slug: SLACK, name: 'Slack', authScheme: 'OAUTH2' },
    ]);
  }

  initiateConnection(input: {
    toolkit: string;
    alias?: string;
  }): Promise<ComposioConnectionRequest> {
    this.counter += 1;
    const connectionRequestId = `cr_${this.counter}`;
    this.requests.set(connectionRequestId, { toolkit: input.toolkit, alias: input.alias });
    return Promise.resolve({
      connectionRequestId,
      redirectUrl: `https://connect.composio.test/${input.toolkit}?cr=${connectionRequestId}`,
    });
  }

  getConnectionState(connectionRequestId: string): Promise<ComposioConnectionState> {
    const request = this.requests.get(connectionRequestId);
    if (!request) return Promise.resolve({ status: 'FAILED', error: 'unknown request' });
    if (!request.caId) {
      this.counter += 1;
      const caId = `ca_${this.counter}`;
      this.accounts.set(caId, {
        connectedAccountId: caId,
        toolkit: request.toolkit,
        ...(request.alias && { alias: request.alias }),
        status: 'ACTIVE',
      });
      request.caId = caId;
    }
    return Promise.resolve({ status: 'ACTIVE', account: this.accounts.get(request.caId) });
  }

  listConnectedAccounts(opts?: { toolkit?: string }): Promise<ComposioConnectedAccount[]> {
    const all = [...this.accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    this.accounts.delete(connectedAccountId);
    return Promise.resolve();
  }
}
