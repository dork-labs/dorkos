import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { AgentConnectorAttachmentStore } from '../../services/connectors/attachment-store.js';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import {
  createAgentConnectorsRouter,
  type AgentConnectorsRouterDeps,
} from '../agent-connectors.js';

const fixture = swappableServer();

describe('agent-connectors retained route', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let store: AgentConnectorAttachmentStore;
  let provider: FakeConnectorProvider;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider();
    registry.register(provider);
    store = new AgentConnectorAttachmentStore(db);
  });

  function mount(
    authorizeOwnerAction: AgentConnectorsRouterDeps['authorizeOwnerAction'] = () => true
  ) {
    const app = express();
    app.use('/api/agents', createAgentConnectorsRouter({ store, registry, authorizeOwnerAction }));
    return fixture.mount(app);
  }

  it('requires owner authority before reads and retired writes', async () => {
    const app = mount((_req, res) => {
      res.status(403).end();
      return false;
    });
    await request(app).get('/api/agents/agent-a/connectors').expect(403);
    await request(fixture.server).post('/api/agents/agent-a/connectors/account-a').expect(403);
    await request(fixture.server).delete('/api/agents/agent-a/connectors/account-a').expect(403);
  });

  it('retains the legacy attachment read for migration visibility', async () => {
    const flow = await provider.startConnect('gmail');
    const account = registry.recordConnect(
      provider,
      (await provider.pollConnect(flow.flowId)).account!
    );
    store.attach('agent-a', account.id);
    const response = await request(mount()).get('/api/agents/agent-a/connectors').expect(200);
    expect(response.body.accounts).toEqual([
      expect.objectContaining({ agentId: 'agent-a', accountId: account.id }),
    ]);
  });

  it.each(['post', 'delete'] as const)(
    '%s returns a typed 410 without changing authority',
    async (method) => {
      const response = await request(mount())[method]('/api/agents/agent-a/connectors/account-a');
      expect(response.status).toBe(410);
      expect(response.body).toEqual({
        code: 'CONNECTOR_ACCESS_MANAGED_IN_CONNECTIONS',
        error: 'Connection access is managed in Connections. Review this agent under /connections.',
      });
      expect(store.listForAgent('agent-a')).toEqual([]);
    }
  );
});
