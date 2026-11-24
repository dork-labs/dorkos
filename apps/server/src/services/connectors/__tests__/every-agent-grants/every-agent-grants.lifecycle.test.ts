import { describe, expect, it, vi } from 'vitest';
import { connectorOperationRevisions, connectorProviderInstances, eq } from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../registry.js';
import {
  createEveryAgentEndedRecorder,
  setOnEveryAgentEnded,
  EVERY_AGENT_CHANGED_EVENT,
} from '../../every-agent-activity.js';
import {
  OWNER,
  NOW,
  CONNECTION_ID,
  useEveryAgentGrantsHarness,
} from './every-agent-grants.fixtures.js';

/** Turning every-agent sharing off and on, moving to a DorkOS account, and the Activity trail. */
describe('every-agent grants', () => {
  const h = useEveryAgentGrantsHarness();

  it('comes back after being turned off and on again (a revoked row is restored)', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    await h.giveEveryAgent([]);
    expect(await h.refusal(h.execute(h.agentPrincipal('agent-new'), read, 'read'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );

    await h.giveEveryAgent(['gmail.read']);
    expect(h.everyAgentRows().map((row) => row.revokedAt)).toEqual([null]);
    await expect(h.execute(h.agentPrincipal('agent-new'), read, 'read')).resolves.toBeDefined();
  });

  it('re-verifies every-agent revisions from an older version in the next preview', async () => {
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'old-read-v0',
        providerInstanceId: h.provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v0',
        schemaHash: 'sha256:fake-read-v1',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    h.strayEveryAgentRow('every-old', CONNECTION_ID, 'old-read-v0');

    const snapshot = await h.preview();
    expect(
      snapshot.candidates.find((candidate) => candidate.operationRevisionId === 'old-read-v0')
    ).toMatchObject({ toolkitVersion: 'v0', supported: true });
    expect(snapshot.everyAgent).toEqual({ available: true, operationRevisionIds: ['old-read-v0'] });
    // Keeping it is a valid selection from this preview.
    await h.reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: ['old-read-v0'] },
    });
    expect(h.everyAgentRows().map((row) => row.revokedAt)).toEqual([null]);
  });

  it("counts it in an agent's own list only for this owner, managed connections included", async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    // A second owner's provider instance with its own every-agent row.
    const foreign = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-foreign'),
      type: 'fake-foreign',
      custody: 'self-host',
      toolkitVersion: 'v1',
    });
    const foreignRegistry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: 'local_install', ownerId: 'install-b' },
    });
    foreignRegistry.register(foreign, 'material-foreign');
    h.insertConnection('connection-foreign', foreign.instanceId);
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'foreign-read',
        providerInstanceId: foreign.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:foreign',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    h.strayEveryAgentRow('every-foreign', 'connection-foreign', 'foreign-read');
    // A managed instance of this owner with a stray every-agent row.
    const managed = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-managed'),
      type: 'fake-managed',
      custody: 'managed',
      toolkitVersion: 'v1',
    });
    h.registry.register(managed, 'material-managed', 'managed');
    h.insertConnection('connection-managed', managed.instanceId);
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'managed-read',
        providerInstanceId: managed.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:managed',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    h.strayEveryAgentRow('every-managed', 'connection-managed', 'managed-read');

    const own = await h.query.agentConnections(OWNER, 'agent-new');
    // The other owner's row never shows; this owner's managed row does, since
    // hosted authority honours every agent too (DOR-2439).
    expect(own.connections.map((connection) => connection.connectionId).sort()).toEqual(
      [CONNECTION_ID, 'connection-managed'].sort()
    );
    expect(
      own.connections.find((connection) => connection.connectionId === CONNECTION_ID)
        ?.operationRevisionIds
    ).toEqual([read]);
    expect(h.query.disconnectImpact(OWNER, 'connection-managed').everyAgent).toBe(true);
  });

  it('ends for good when the instance moves to a DorkOS account', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    h.grantNamed('named-survives-move', 'agent-a', h.revisionId(snapshot, 'gmail.write'));
    setOnEveryAgentEnded(createEveryAgentEndedRecorder(h.activity));
    h.activity.emit.mockClear();
    h.registry.register(h.provider, 'material-a', 'managed');
    // Only the every-agent row ends; a grant made to one agent by name does not.
    expect(h.namedRevokedAt('named-survives-move')).toBeNull();
    await vi.waitFor(() =>
      expect(h.activity.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EVERY_AGENT_CHANGED_EVENT,
          actorLabel: 'DorkOS',
          summary:
            'Stopped sharing Gmail (Work Gmail) with every agent because it now connects through your DorkOS account',
        })
      )
    );
    expect(h.everyAgentRows().map((row) => row.revokedAt)).toEqual([expect.any(String)]);
    h.registry.register(h.provider, 'material-a', 'byo');
    expect(h.everyAgentRows().map((row) => row.revokedAt)).toEqual([expect.any(String)]);
    expect(
      await h.refusal(
        h.execute(h.agentPrincipal('agent-new'), h.revisionId(snapshot, 'gmail.read'), 'read')
      )
    ).not.toBeUndefined();
    expect(h.query.disconnectImpact(OWNER, CONNECTION_ID).everyAgent).toBe(false);
  });

  it('stops sharing with no preview, even while the provider is unavailable', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read', 'gmail.write']);
    h.grantNamed('named-survives-stop', 'agent-a', h.revisionId(snapshot, 'gmail.read'));
    h.activity.emit.mockClear();
    h.db
      .update(connectorProviderInstances)
      .set({ status: 'unavailable' })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();
    await expect(
      h.reconciliation.preview(OWNER, { connectionId: CONNECTION_ID }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'connection_not_found' });

    await expect(
      h.reconciliation.revokeEveryAgent(
        { kind: 'local_install', installationId: 'install-b' },
        CONNECTION_ID
      )
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    expect(h.everyAgentRows().every((row) => row.revokedAt === null)).toBe(true);

    await expect(h.reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      revokedCount: 2,
    });
    expect(h.everyAgentRows().every((row) => row.revokedAt !== null)).toBe(true);
    // Stopping the sharing never touches what an agent was given by name.
    expect(h.namedRevokedAt('named-survives-stop')).toBeNull();
    expect(h.activity.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: EVERY_AGENT_CHANGED_EVENT,
        summary: 'Stopped sharing Gmail (Work Gmail) with every agent',
        actorLabel: 'Someone on this computer',
      })
    );
    await expect(h.reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      revokedCount: 0,
    });
    expect(
      await h.refusal(
        h.execute(h.agentPrincipal('agent-new'), h.revisionId(snapshot, 'gmail.read'), 'read')
      )
    ).not.toBeUndefined();
  });

  it('leaves a trail when sharing starts or widens, whoever sent it', async () => {
    await h.giveEveryAgent(['gmail.read']);
    expect(h.activity.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: 'permissions',
        eventType: EVERY_AGENT_CHANGED_EVENT,
        resourceId: CONNECTION_ID,
        summary: 'Shared Gmail (Work Gmail) with every agent, including agents added later: read',
        actorLabel: 'Someone on this computer',
      })
    );
    await h.giveEveryAgent(['gmail.read', 'gmail.write']);
    expect(h.activity.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: 'Changed what every agent can do with Gmail (Work Gmail): read and write',
      })
    );
    h.activity.emit.mockClear();
    await h.giveEveryAgent(['gmail.read', 'gmail.write']);
    expect(h.activity.emit).not.toHaveBeenCalled();
  });
});
