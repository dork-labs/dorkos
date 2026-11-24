import { describe, expect, it } from 'vitest';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  isNull,
  sessionConnectionOverrides,
} from '@dorkos/db';
import { ConnectorExecutionTargetSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorReconciliationError } from '../../reconciliation-service.js';
import {
  OWNER,
  NOW,
  CONNECTION_ID,
  codeOf,
  useEveryAgentGrantsHarness,
} from './every-agent-grants.fixtures.js';

/** What an every-agent grant gives, how overrides and revocation apply, and where it is refused. */
describe('every-agent grants', () => {
  const h = useEveryAgentGrantsHarness();

  it('gives an agent created after the grant exactly the reviewed revisions, and nothing newer', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    const write = h.revisionId(snapshot, 'gmail.write');

    expect(h.everyAgentRows()).toEqual([
      expect.objectContaining({
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        operationRevisionId: read,
        createdBy: OWNER.installationId,
        revokedAt: null,
      }),
    ]);
    await expect(h.execute(h.agentPrincipal('agent-new'), read, 'read')).resolves.toMatchObject({
      agentId: 'agent-new',
    });
    expect(await h.refusal(h.execute(h.agentPrincipal('agent-new'), write, 'write'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );

    // The provider ships a new version of the same operation: it stays off until reviewed.
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'gmail-read-v2',
        providerInstanceId: h.provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'v2',
        schemaHash: 'sha256:fake-read-v2',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    expect(await h.refusal(h.execute(h.agentPrincipal('agent-new'), 'gmail-read-v2', 'read'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
    // An every-agent grant never lets a call change its classification.
    expect(await h.refusal(h.execute(h.agentPrincipal('agent-new'), read, 'write'))).toBe(
      'CONNECTOR_CAPABILITY_MISMATCH'
    );
  });

  it('covers system agents such as DorkBot, because they are agents', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    await expect(
      h.execute(h.agentPrincipal('dorkbot'), h.revisionId(snapshot, 'gmail.read'), 'read')
    ).resolves.toMatchObject({ agentId: 'dorkbot' });
  });

  it('adds to a named-agent grant without narrowing it', async () => {
    const first = await h.preview();
    await h.reconciliation.apply(OWNER, {
      previewId: first.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: [h.revisionId(first, 'gmail.write')] }],
      everyAgent: { operationRevisionIds: [h.revisionId(first, 'gmail.read')] },
    });

    await expect(
      h.execute(h.agentPrincipal('agent-a'), h.revisionId(first, 'gmail.write'), 'write')
    ).resolves.toBeDefined();
    await expect(
      h.execute(h.agentPrincipal('agent-a'), h.revisionId(first, 'gmail.read'), 'read')
    ).resolves.toBeDefined();
    expect(
      await h.refusal(
        h.execute(h.agentPrincipal('agent-new'), h.revisionId(first, 'gmail.write'), 'write')
      )
    ).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it('lets a session override decide alone: detached denies and attached never widens', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    const write = h.revisionId(snapshot, 'gmail.write');
    h.db
      .insert(sessionConnectionOverrides)
      .values([
        {
          sessionId: 'session-detached',
          agentId: 'agent-new',
          connectionId: CONNECTION_ID,
          state: 'detached',
          updatedAt: NOW.toISOString(),
        },
        {
          sessionId: 'session-attached',
          agentId: 'agent-new',
          connectionId: CONNECTION_ID,
          state: 'attached',
          updatedAt: NOW.toISOString(),
        },
      ])
      .run();
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'session-write',
        subjectType: 'session',
        subjectId: 'session-attached',
        agentId: 'agent-new',
        connectionId: CONNECTION_ID,
        operationRevisionId: write,
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();

    // No override: the every-agent grant applies.
    await expect(
      h.execute(h.runtimePrincipal('agent-new', 'session-plain'), read, 'read')
    ).resolves.toBeDefined();
    expect(
      await h.refusal(h.execute(h.runtimePrincipal('agent-new', 'session-detached'), read, 'read'))
    ).toBe('CONNECTOR_GRANT_REQUIRED');
    // The refusal says the chat turned it off, never "not granted".
    await expect(
      h.execute(h.runtimePrincipal('agent-new', 'session-detached'), read, 'read')
    ).rejects.toMatchObject({
      payload: {
        reason: 'off_for_this_chat',
        error: CONNECTION_READINESS_COPY.off_for_this_chat.agent,
      },
    });
    expect(
      await h.refusal(h.execute(h.runtimePrincipal('agent-new', 'session-attached'), read, 'read'))
    ).toBe('CONNECTOR_GRANT_REQUIRED');
    await expect(
      h.execute(h.runtimePrincipal('agent-new', 'session-attached'), write, 'write')
    ).resolves.toBeDefined();

    // The runtime tool list agrees with the check, session by session.
    await expect(
      h.access.listRuntimeConnections(h.runtimePrincipal('agent-new', 'session-detached'))
    ).resolves.toEqual({
      connections: [],
      unavailable: [expect.objectContaining({ reason: 'off_for_this_chat' })],
    });
    const attached = await h.access.listRuntimeOperations(
      h.runtimePrincipal('agent-new', 'session-attached'),
      CONNECTION_ID
    );
    expect(attached.operations.map((operation) => operation.operationRevisionId)).toEqual([write]);
  });

  it('revokes for every agent at once, including a call already prepared inside a turn', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    const principal = h.runtimePrincipal('agent-new', 'session-running');
    const input = {
      capabilityId: 'connectors.execute_read' as const,
      principal,
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId: read,
        arguments: {},
      }),
    };
    const prepared = await h.authorization.prepare(input);

    await h.giveEveryAgent([]);

    let recheck: string | undefined;
    try {
      h.authorization.recheckPreparedSynchronously(input, prepared);
    } catch (error) {
      recheck = codeOf(error);
    }
    expect(recheck).toBe('CONNECTOR_GRANT_REQUIRED');
    expect(await h.refusal(h.execute(h.agentPrincipal('dorkbot'), read, 'read'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
    await expect(h.access.listRuntimeConnections(principal)).resolves.toEqual({ connections: [] });
    expect(h.everyAgentRows().every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('survives removing an agent, and ends when the connection is disconnected', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'named-write',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: h.revisionId(snapshot, 'gmail.write'),
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();

    h.registry.recordAgentRemoval('agent-a');
    h.registry.removeAgentAccess('agent-a');
    h.registry.removeAgentConnectionAccess('agent-a', CONNECTION_ID);
    expect(
      h.db
        .select({ revokedAt: connectionOperationGrants.revokedAt })
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.id, 'named-write'))
        .get()?.revokedAt
    ).not.toBeNull();
    expect(h.everyAgentRows().map((row) => row.revokedAt)).toEqual([null]);
    await expect(h.execute(h.agentPrincipal('agent-new'), read, 'read')).resolves.toBeDefined();

    h.registry.recordDisconnect(CONNECTION_ID);
    expect(h.everyAgentRows().map((row) => row.revokedAt)).toEqual([expect.any(String)]);
    expect(h.query.everyAgentGrants(OWNER)).toEqual({ connections: [] });
    expect(await h.refusal(h.execute(h.agentPrincipal('agent-new'), read, 'read'))).toBe(
      'CONNECTOR_NOT_EXECUTABLE'
    );
  });

  it('refuses a call on an account that isn’t ready with the words for the agent: why, and what the person does', async () => {
    const snapshot = await h.giveEveryAgent(['gmail.read']);
    const read = h.revisionId(snapshot, 'gmail.read');
    const payloadOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return undefined;
      } catch (error) {
        return (error as { payload?: Record<string, unknown> }).payload;
      }
    };

    h.registry.setPaused(CONNECTION_ID, true);
    expect(await payloadOf(h.execute(h.agentPrincipal('agent-new'), read, 'read'))).toEqual({
      code: 'CONNECTOR_NOT_EXECUTABLE',
      reason: 'paused',
      error: expect.stringContaining('Ask them to resume it'),
    });
    h.registry.setPaused(CONNECTION_ID, false);

    // The way goes: the refusal names that, never "the provider is unavailable".
    h.registry.unregisterProviderInstance(h.provider.instanceId);
    const gone = await payloadOf(h.execute(h.agentPrincipal('agent-new'), read, 'read'));
    expect(gone).toMatchObject({ reason: 'way_unreachable' });
    expect(String(gone?.error)).not.toMatch(/provider|connector/i);
  });

  it('refuses a revision the owner did not review in this preview', async () => {
    const snapshot = await h.preview();
    await expect(
      h.reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: { operationRevisionIds: ['not-reviewed'] },
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    await expect(
      h.reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: {
          operationRevisionIds: [
            h.revisionId(snapshot, 'gmail.read'),
            h.revisionId(snapshot, 'gmail.read'),
          ],
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    expect(h.everyAgentRows()).toEqual([]);
  });

  it('is unavailable through a DorkOS account only while nothing can carry it to hosted authority', async () => {
    // This service has no managed synchronizer, so nothing could reach the
    // hosted side that decides every managed call (DOR-2439).
    h.db
      .update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();
    const snapshot = await h.preview();
    expect(snapshot.everyAgent).toEqual({ available: false, operationRevisionIds: [] });
    const refused = h.reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [h.revisionId(snapshot, 'gmail.read')] },
    });
    await expect(refused).rejects.toBeInstanceOf(ConnectorReconciliationError);
    await expect(refused).rejects.toMatchObject({ code: 'every_agent_unavailable' });
    expect(h.everyAgentRows()).toEqual([]);

    // A local row hosted authority never applied still runs nothing: a
    // managed call needs the applied hosted scope that authorizes it.
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'stray-every-agent',
        subjectType: 'every_agent',
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        connectionId: CONNECTION_ID,
        operationRevisionId: h.revisionId(snapshot, 'gmail.read'),
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
    expect(
      await h.refusal(
        h.execute(h.agentPrincipal('agent-new'), h.revisionId(snapshot, 'gmail.read'), 'read')
      )
    ).not.toBeUndefined();
  });

  it('shows the owner what every agent, including a new one, will get', async () => {
    expect(h.query.everyAgentGrants(OWNER)).toEqual({ connections: [] });
    const snapshot = await h.giveEveryAgent(['gmail.read', 'gmail.write']);
    const ids = [
      h.revisionId(snapshot, 'gmail.read'),
      h.revisionId(snapshot, 'gmail.write'),
    ].sort();
    const expectedAccess = { operationRevisionIds: ids, classifications: ['read', 'write'] };

    expect(h.query.everyAgentGrants(OWNER)).toEqual({
      connections: [
        {
          connectionId: CONNECTION_ID,
          toolkit: 'gmail',
          label: 'Work Gmail',
          lifecycle: 'connected',
          access: expectedAccess,
        },
      ],
    });
    const [summary] = await h.query.listConnections(OWNER);
    expect(summary?.everyAgent).toEqual(expectedAccess);
    expect(h.query.disconnectImpact(OWNER, CONNECTION_ID).everyAgent).toBe(true);
    await expect(h.query.agentConnections(OWNER, 'agent-new')).resolves.toMatchObject({
      connections: [{ connectionId: CONNECTION_ID, operationRevisionIds: ids, everyAgent: true }],
    });
    const again = await h.preview();
    expect(again.everyAgent).toEqual({ available: true, operationRevisionIds: ids });

    // Another owner sees none of it.
    expect(
      h.query.everyAgentGrants({ kind: 'local_install', installationId: 'install-b' })
    ).toEqual({
      connections: [],
    });
    // Paused still inherits once resumed, so it is still disclosed, marked paused.
    h.db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION_ID)).run();
    expect(h.query.everyAgentGrants(OWNER).connections[0]?.lifecycle).toBe('paused');
    expect(
      h.db
        .select()
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'agent'),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .all()
    ).toEqual([]);
  });
});
