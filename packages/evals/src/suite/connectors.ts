/**
 * The connectors suite — the two W4 connector evals (connector-gateway spec
 * §Testing Strategy G5, `plans/shapes-program.md` W4) expressed against the
 * `ConnectorProvider` interface with FAKES, never live credentials:
 *
 * - **`connector-gmail`** ("Connect to my Gmail") drives the gateway path:
 *   `recommendConnector('gmail')` tops with a gateway; two connects of one
 *   toolkit yield two distinct, independently-addressable accounts; both expose
 *   a tool server; the injected session servers carry no provider identity (G2);
 *   and the refined eval-13 oracle holds — the only persisted credential
 *   reference on the managed path is the vendor API-key ref, never a per-account
 *   token ref.
 * - **`connector-slack`** ("Connect to Slack") is the discriminating routing
 *   eval: `recommendConnector('slack')` tops with the purpose-built relay
 *   adapter, ranked ABOVE any generic gateway.
 *
 * WHY FAKE-BACKED AND STRUCTURAL: these prove the two evals are EXPRESSIBLE
 * against the spec'd interface and hold as a deterministic contract. Their
 * oracles exercise the real `recommendConnector` / `ConnectorRegistry` /
 * `SessionConnectorService` / Composio-provider code with a
 * {@link @dorkos/test-utils!FakeConnectorProvider} and an in-memory Composio
 * client, so they run on `test-mode` (no model, no key, free) and gate nothing
 * they cannot deterministically prove.
 *
 * WHY STILL `quarantined` (spec: "Quarantined until W5"): the LIVE promotion —
 * a real model driving the connect flow end-to-end through the connector MCP
 * tools against a mock OAuth provider (CI) or a real provider sandbox (weekly,
 * D5) — is the W5 gate and needs the connector tool surface wired into the
 * harness. Until that lands, these interface-contract cases are the honest,
 * green proof (demo-claim gate); they never claim the surface works end-to-end.
 *
 * @module evals/suite/connectors
 */
import { FakeConnectorProvider } from '@dorkos/test-utils/fake-connector-provider';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ConnectorRegistry,
  SessionConnectorService,
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
  type ComposioMcpSession,
} from '@dorkos/server/services/connectors';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import type { EvalCase, Oracle, OracleResult } from '../types.js';

/** The service the gateway eval connects (multi-account by design). */
const GMAIL = 'gmail';
/** The service the routing eval discriminates (relay adapter beats the gateway). */
const SLACK = 'slack';
/** Real vendor product names that must never leak into a session tool server (G2). */
const VENDOR_IDENTITIES = ['composio', 'nango', 'rube'];

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
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  if (!account) throw new Error(`connect for '${label}' produced no account`);
  return account;
}

/** A gateway with two connected Gmail accounts, registered for routing + exposure. */
async function twoGmailAccounts(providerType: string): Promise<{
  registry: ConnectorRegistry;
  provider: FakeConnectorProvider;
  personal: ConnectedAccount;
  work: ConnectedAccount;
}> {
  const registry = new ConnectorRegistry({ db: createTestDb() });
  const provider = new FakeConnectorProvider({
    type: providerType,
    custody: 'managed',
    supportsMultiAccount: true,
  });
  registry.register(provider);
  const personal = await connectOne(provider, GMAIL, 'personal');
  const work = await connectOne(provider, GMAIL, 'work');
  registry.recordConnect(personal);
  registry.recordConnect(work);
  return { registry, provider, personal, work };
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

/** Two connects of Gmail yield two distinct accounts, each exposing a tool server. */
const gmailTwoAccountAddressing: Oracle = async (): Promise<OracleResult> => {
  const { provider, personal, work } = await twoGmailAccounts('composio');
  const distinct = personal.id !== work.id;
  const accounts = await provider.listAccounts({ toolkit: GMAIL });
  const serverPersonal = await provider.toolServerForAccount(personal.id);
  const serverWork = await provider.toolServerForAccount(work.id);
  const passed =
    distinct && accounts.length === 2 && serverPersonal !== null && serverWork !== null;
  return {
    label: 'two Gmail accounts are distinct and each exposes a tool server',
    passed,
    evidence: { ids: [personal.id, work.id], count: accounts.length },
    ...(passed ? {} : { detail: 'expected two distinct ids, both with a non-null tool server' }),
  };
};

/** Attached accounts inject two provider-neutral named servers, with no vendor identity (G2). */
const gmailNoProviderLeakage: Oracle = async (): Promise<OracleResult> => {
  // A NEUTRAL fake type so the fake's namespaced account id cannot itself smuggle
  // a real vendor name into the assertion — G2 is about the vendor's identity
  // (composio/nango/rube) never appearing, and the server name being toolkit+label.
  const { registry, personal, work } = await twoGmailAccounts('gateway-under-test');
  const service = new SessionConnectorService({ registry });
  const sessionId = 'connector-gmail-eval';
  await service.attach(sessionId, personal.id);
  await service.attach(sessionId, work.id);

  const { servers } = service.mcpServersForSession(sessionId);
  const names = Object.keys(servers).sort();
  const twoNamedByToolkitLabel =
    names.length === 2 && names[0] === 'gmail-personal' && names[1] === 'gmail-work';
  const blob = JSON.stringify(servers).toLowerCase();
  const leaked = VENDOR_IDENTITIES.filter((v) => blob.includes(v));
  const passed = twoNamedByToolkitLabel && leaked.length === 0;
  return {
    label: 'two named servers (gmail-personal, gmail-work) with no provider identity',
    passed,
    evidence: { names, leaked },
    ...(passed
      ? {}
      : { detail: `names=${JSON.stringify(names)} leaked=${JSON.stringify(leaked)}` }),
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
  // Drive two connects; the per-account handles are opaque `ca_…` ids, NOT
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
    firstAccount?.id.includes('ca_') &&
    secondAccount?.id.includes('ca_') &&
    firstAccount.id !== secondAccount.id
  );
  const passed = onlyVendorKeyResolved && vendorRefIsNotAccountScoped && accountsAreOpaqueHandles;
  return {
    label: 'managed path resolves only the vendor API-key ref, never a per-account token ref',
    passed,
    evidence: { resolveCalls, accountIds: [firstAccount?.id, secondAccount?.id] },
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
  title: 'Connect to my Gmail — the gateway path, two accounts, no provider leakage',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['connector'],
  quarantined: true,
  oracles: [
    gmailRoutesToGateway,
    gmailTwoAccountAddressing,
    gmailNoProviderLeakage,
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

  mcpSessionForAccount(connectedAccountId: string): Promise<ComposioMcpSession | null> {
    const account = this.accounts.get(connectedAccountId);
    if (!account || account.status !== 'ACTIVE') return Promise.resolve(null);
    return Promise.resolve({ url: `https://rube.app/mcp/${connectedAccountId}` });
  }
}
