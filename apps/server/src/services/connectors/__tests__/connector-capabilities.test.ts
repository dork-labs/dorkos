/**
 * The connector capability domain (connector-completion spec §Detailed Design
 * 2): the full connect-to-attach conversation flow against a fake provider, the
 * disclosure-verbatim guarantee on `start_connect`, the sessionId defaulting
 * matrix, the provider-strip guarantee, and the approval-gate posture of
 * `connector.attach_account`.
 *
 * Handlers are driven directly (`capability.invoke(deps, input, context)`) —
 * the marketplace domain's test pattern — except the gate assertions, which go
 * through `registry.invoke` because the tier gate lives inside it (DOR-467).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';

import { connectorDomain, type ConnectorCapabilityDeps } from '../connector-capabilities.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorFlowBindings } from '../flow-bindings.js';
import { SessionConnectorService } from '../session-exposure.js';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../attachment-store.js';
import { custodyDisclosure } from '../custody-disclosure.js';
import type { CapabilityDeps } from '../../core/capabilities/index.js';
import { composeDorkOsCapabilityRegistry } from '../../core/self-description/dorkos-registry.js';
import { initCapabilityTierGate } from '../../core/capabilities/tier-enforcement.js';
import { ApprovalService } from '../../core/approvals/index.js';

/** Resolve one capability by id, throwing when the domain stops declaring it. */
function capability(id: string) {
  const found = connectorDomain.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`connector domain no longer declares ${id}`);
  return found;
}

describe('connector capabilities', () => {
  let db: Db;
  let connectorRegistry: ConnectorRegistry;
  let flowBindings: ConnectorFlowBindings;
  let sessionConnectors: SessionConnectorService;
  let deps: CapabilityDeps;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    connectorRegistry = new ConnectorRegistry({ db });
    connectorRegistry.register(new FakeConnectorProvider({ type: 'composio', custody: 'managed' }));
    flowBindings = new ConnectorFlowBindings();
    sessionConnectors = new SessionConnectorService({
      registry: connectorRegistry,
      agentAttachments: new AgentConnectorAttachmentStore(db),
      sessionAttachments: new SessionConnectorAttachmentStore(db),
    });
    const connectorDeps: ConnectorCapabilityDeps = {
      registry: connectorRegistry,
      sessionConnectors,
      flowBindings,
      relay: { getManifest: (type) => (type === 'slack' ? { displayName: 'Slack' } : undefined) },
    };
    deps = { logger: noopLogger, connectorDeps };
  });

  /** Drive start_connect → poll_connect to a connected public account. */
  async function connectViaCapabilities(label = 'work') {
    const started = (await capability('connector.start_connect').invoke(
      deps,
      { service: 'gmail', label },
      {}
    )) as { flowId: string; authorizeUrl: string; disclosure: string; message: string };
    const polled = (await capability('connector.poll_connect').invoke(
      deps,
      { flowId: started.flowId },
      {}
    )) as { status: string; account?: { id: string; disclosure: string } };
    return { started, polled };
  }

  describe('the connect-to-attach conversation flow', () => {
    it('list_toolkits → recommend → start_connect → poll_connect → list_accounts → attach → detach', async () => {
      const toolkits = (await capability('connector.list_toolkits').invoke(deps, {}, {})) as {
        toolkits: { slug: string }[];
      };
      expect(toolkits.toolkits.map((tk) => tk.slug)).toContain('gmail');

      const recommended = (await capability('connector.recommend').invoke(
        deps,
        { service: 'gmail' },
        {}
      )) as { recommendations: { kind: string; provider?: string }[] };
      expect(recommended.recommendations[0]).toMatchObject({
        kind: 'gateway',
        provider: 'composio',
      });

      const { started, polled } = await connectViaCapabilities();
      expect(started.authorizeUrl).toContain('gmail');
      expect(polled.status).toBe('connected');

      const listed = (await capability('connector.list_accounts').invoke(deps, {}, {})) as {
        accounts: { id: string }[];
      };
      expect(listed.accounts.map((a) => a.id)).toContain(polled.account!.id);

      // Attach defaults to the invoking session (in-session context).
      const attached = (await capability('connector.attach_account').invoke(
        deps,
        { accountId: polled.account!.id },
        { sessionId: 'session-1' }
      )) as { sessionId: string; account: { exposed: boolean }; disclosure: string };
      expect(attached.sessionId).toBe('session-1');
      expect(attached.account.exposed).toBe(true);
      expect(attached.disclosure.length).toBeGreaterThan(0);
      // The session now injects the account's tool server.
      expect(Object.keys(sessionConnectors.mcpServersForSession('session-1').servers)).toHaveLength(
        1
      );

      const detached = (await capability('connector.detach_account').invoke(
        deps,
        { accountId: polled.account!.id },
        { sessionId: 'session-1' }
      )) as { detached: boolean };
      expect(detached.detached).toBe(true);
      expect(Object.keys(sessionConnectors.mcpServersForSession('session-1').servers)).toHaveLength(
        0
      );
    });

    it('relay-adapter services still lead in recommend, but start_connect routes to the gateway', async () => {
      // The fake gateway also lists slack, so both routes exist; recommend puts
      // the purpose-built adapter first, start_connect (which cannot open a
      // relay surface) picks the top gateway.
      const recommended = (await capability('connector.recommend').invoke(
        deps,
        { service: 'slack' },
        {}
      )) as { recommendations: { kind: string }[] };
      expect(recommended.recommendations[0]!.kind).toBe('relay-adapter');

      const started = (await capability('connector.start_connect').invoke(
        deps,
        { service: 'slack' },
        {}
      )) as { flowId: string };
      expect(flowBindings.providerFor(started.flowId)).toBe('composio');
    });

    it('start_connect fails honestly when nothing can connect the service', async () => {
      await expect(
        capability('connector.start_connect').invoke(deps, { service: 'fax-machine' }, {})
      ).rejects.toMatchObject({ name: 'CapabilityToolError' });
    });

    it('poll_connect rejects an unknown flow with a structured error', async () => {
      await expect(
        capability('connector.poll_connect').invoke(deps, { flowId: 'never-started' }, {})
      ).rejects.toMatchObject({ name: 'CapabilityToolError' });
    });
  });

  describe('start_connect markdown (the v1 in-chat connect experience)', () => {
    it('carries the auth URL, the EXACT custody disclosure, and the follow-up ask', async () => {
      const { started } = await connectViaCapabilities();
      // The disclosure is byte-verbatim from the custody-disclosure module —
      // no surface may compose its own custody copy.
      const expected = custodyDisclosure('managed', { service: 'gmail' });
      expect(started.disclosure).toBe(expected);
      expect(started.message).toContain(started.authorizeUrl);
      expect(started.message).toContain(expected);
      expect(started.message).toContain("Tell me when you've signed in");
    });
  });

  describe('the shared flow-binding map (one map, both surfaces)', () => {
    it('records the binding on start and releases it on a terminal poll', async () => {
      const started = (await capability('connector.start_connect').invoke(
        deps,
        { service: 'gmail' },
        {}
      )) as { flowId: string };
      // The SAME instance the REST router is handed — a flow started in chat is
      // pollable over REST because this binding exists.
      expect(flowBindings.providerFor(started.flowId)).toBe('composio');

      await capability('connector.poll_connect').invoke(deps, { flowId: started.flowId }, {});
      expect(flowBindings.providerFor(started.flowId)).toBeUndefined();
    });
  });

  describe('sessionId defaulting matrix', () => {
    it('in-session: defaults to the invoking session from the handler context', async () => {
      const { polled } = await connectViaCapabilities();
      const attached = (await capability('connector.attach_account').invoke(
        deps,
        { accountId: polled.account!.id },
        { sessionId: 'invoking-session' }
      )) as { sessionId: string };
      expect(attached.sessionId).toBe('invoking-session');
    });

    it('an explicit sessionId input wins over the invoking session', async () => {
      const { polled } = await connectViaCapabilities();
      const attached = (await capability('connector.attach_account').invoke(
        deps,
        { accountId: polled.account!.id, sessionId: 'explicit-session' },
        { sessionId: 'invoking-session' }
      )) as { sessionId: string };
      expect(attached.sessionId).toBe('explicit-session');
      expect(
        Object.keys(sessionConnectors.mcpServersForSession('explicit-session').servers)
      ).toHaveLength(1);
    });

    it('external (no invoking session): a clear error without an explicit sessionId', async () => {
      const { polled } = await connectViaCapabilities();
      for (const id of ['connector.attach_account', 'connector.detach_account']) {
        await expect(
          capability(id).invoke(deps, { accountId: polled.account!.id }, {})
        ).rejects.toMatchObject({
          name: 'CapabilityToolError',
          payload: { error: expect.stringContaining('sessionId') },
        });
      }
    });
  });

  describe('provider-strip guarantee', () => {
    it('poll_connect and list_accounts never expose the server-only provider field', async () => {
      const { polled } = await connectViaCapabilities();
      expect(Object.keys(polled.account!)).not.toContain('provider');

      const listed = (await capability('connector.list_accounts').invoke(deps, {}, {})) as {
        accounts: Record<string, unknown>[];
      };
      for (const account of listed.accounts) {
        expect(Object.keys(account)).not.toContain('provider');
        // Every listed account carries its own custody line (spec §4).
        expect(typeof account.disclosure).toBe('string');
      }
    });
  });

  describe('tier posture', () => {
    it('reads carry the read-only carve-out; attach is the one destructive consent point', () => {
      const reads = ['connector.list_toolkits', 'connector.recommend', 'connector.list_accounts'];
      for (const id of reads) {
        const cap = capability(id);
        expect(cap.tier).toBe('observe');
        expect(cap.surfaces.mcp?.readOnlyCarveOut).toBe(true);
      }
      for (const id of ['connector.start_connect', 'connector.poll_connect']) {
        expect(capability(id).tier).toBe('act');
        expect(capability(id).surfaces.mcp?.readOnlyCarveOut).toBeUndefined();
      }
      const attach = capability('connector.attach_account');
      expect(attach.tier).toBe('destructive');
      expect(attach.approvalDisplayFields).toEqual(['accountId', 'sessionId']);
      expect(capability('connector.detach_account').tier).toBe('act');
    });

    it('registry.invoke refuses an unapproved attach — the gate is the consent point', async () => {
      // Arm the gate over a throwaway approval service, exactly as boot does.
      initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
      const registry = composeDorkOsCapabilityRegistry({
        logger: noopLogger,
        connectorDeps: deps.connectorDeps!,
      });
      const { polled } = await connectViaCapabilities();

      await expect(
        registry.invoke('connector.attach_account', {
          accountId: polled.account!.id,
          sessionId: 'session-1',
        })
      ).rejects.toMatchObject({ name: 'CapabilityGateRefusal' });
      // The consent was never granted, so nothing was attached.
      expect(sessionConnectors.status('session-1').accounts).toHaveLength(0);
    });
  });

  describe('attach null branch', () => {
    it('surfaces an unexposable account as a warning on the result, never a throw', async () => {
      const provider = connectorRegistry.resolveProvider('composio') as FakeConnectorProvider;
      const { polled } = await connectViaCapabilities();
      provider.setStatus(polled.account!.id as ConnectedAccountId, 'expired');
      // The routing cache still says active (best-effort), so re-record with the
      // expired status the provider now reports to drive the warning path.
      connectorRegistry.recordDisconnect(polled.account!.id as ConnectedAccountId);
      connectorRegistry.recordConnect({
        ...(await provider.listAccounts())[0]!,
      });

      const attached = (await capability('connector.attach_account').invoke(
        deps,
        { accountId: polled.account!.id },
        { sessionId: 'session-1' }
      )) as { account: { exposed: boolean }; warning?: { reason: string } };
      expect(attached.account.exposed).toBe(false);
      expect(attached.warning?.reason).toBe('expired');
    });

    it('rejects an unknown account with a structured error', async () => {
      await expect(
        capability('connector.attach_account').invoke(
          deps,
          { accountId: 'never-connected' },
          { sessionId: 'session-1' }
        )
      ).rejects.toMatchObject({ name: 'CapabilityToolError' });
    });
  });
});
