/**
 * `ctx.connections`, host side (DOR-3547): the approval store and the reader
 * against a real migrated database and a scripted provider. Made-up data only.
 *
 * Covers QA's four acceptance tests and Security's conditions that live here:
 * N1 (files digest), N2 (keyed on the install), P4-2 (grants follow the
 * approval, revoked in the same transaction), M5/P4-3 (read only), Q5 (8 MB),
 * Q7 (origin), S2 (isolated with sqlite refused), S6/P4-5 (usage rows), and the
 * refusal of accounts reached through a DorkOS account.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  createDb,
  eq,
  extensionConnectionApprovals,
  runMigrations,
  sql,
  type Db,
} from '@dorkos/db';
import {
  ConnectorProviderInstanceIdSchema,
  type ConnectorProviderExecuteCommand,
  type ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorUsageStore } from '../../execution/usage-store.js';
import { ExtensionConnectionApprovalStore } from '../extension-connection-approvals.js';
import { ExtensionConnectionReader } from '../extension-connection-reader.js';
import type { LiveExtensionInstall } from '../live-extension-install.js';

const NOW = '2026-11-08T12:00:00.000Z';
const CONNECTION = 'linear-work';
const LIST = 'LINEAR_LIST_LINEAR_PROJECTS';
const GET = 'LINEAR_GET_LINEAR_PROJECT';
const UPDATE = 'LINEAR_UPDATE_ISSUE';
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { first: { type: 'integer' } },
});

interface Scripted extends ConnectorProvider {
  readonly commands: ConnectorProviderExecuteCommand[];
  readonly results: ConnectorProviderExecuteResult[];
  beforeDispatch?: () => void;
  /** Runs once the request has left: what happens while the app answers. */
  afterDispatch?: (command: ConnectorProviderExecuteCommand) => void;
}

/** A fake provider that records commands and returns scripted results. */
function scriptedProvider(): Scripted {
  const base = new FakeConnectorProvider({
    instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
    type: 'fake',
  });
  const provider = base as unknown as Scripted;
  const commands: ConnectorProviderExecuteCommand[] = [];
  const results: ConnectorProviderExecuteResult[] = [];
  Object.defineProperties(provider, {
    commands: { value: commands },
    results: { value: results },
    execute: {
      value: async (command: ConnectorProviderExecuteCommand) => {
        commands.push(command);
        provider.beforeDispatch?.();
        if (!(await command.authorizeDispatch())) {
          return {
            status: 'error' as const,
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Access changed before the operation was sent.',
            retryable: false,
          };
        }
        provider.afterDispatch?.(command);
        return results.shift() ?? { status: 'success' as const, data: { projects: [] } };
      },
    },
  });
  return provider;
}

/** A running install of `flow-owner` (override any fact). */
function installOf(overrides: Partial<LiveExtensionInstall> = {}): LiveExtensionInstall {
  return {
    extensionId: 'flow-owner',
    scope: 'global',
    realPath: '/home/me/.dork/extensions/flow-owner',
    origin: 'trusted_source',
    originSource: 'dork-labs/marketplace',
    liveFilesDigest: 'sha256:files-1',
    version: '0.2.0',
    declarations: [{ service: 'linear', access: 'read', operations: [LIST, GET, UPDATE] }],
    isolated: () => true,
    ...overrides,
  };
}

describe('extension connections, host side', () => {
  let db: Db;
  let provider: Scripted;
  let approvals: ExtensionConnectionApprovalStore;
  let reader: ExtensionConnectionReader;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    provider = scriptedProvider();
    const registry = new ConnectorRegistry({ db });
    registry.register(provider);
    db.update(connectorProviderInstances)
      .set({
        mode: 'byo',
        ownerKind: 'local_install',
        ownerId: 'install-a',
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'account-ref',
        toolkit: 'linear',
        label: 'Work Linear',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const revision = (id: string, slug: string, classification: 'read' | 'write') => ({
      id,
      providerInstanceId: provider.instanceId,
      toolkit: 'linear',
      operationSlug: slug,
      toolkitVersion: '1',
      schemaHash: `sha256:${id}`,
      capabilityClassification: classification,
      retryPolicy: 'never' as const,
      inputSchemaJson: SCHEMA,
      discoveredAt: NOW,
    });
    db.insert(connectorOperationRevisions)
      .values([
        revision('rev-list', LIST, 'read'),
        revision('rev-get', GET, 'read'),
        revision('rev-update', UPDATE, 'write'),
      ])
      .run();
    approvals = new ExtensionConnectionApprovalStore(db, () => new Date(NOW));
    reader = new ExtensionConnectionReader(
      db,
      registry,
      approvals,
      new ConnectorUsageStore(db),
      () => new Date(NOW)
    );
  });

  const approve = (install = installOf()) =>
    approvals.approve({
      install,
      service: 'linear',
      connectionId: CONNECTION,
      approvedBy: 'owner',
    });
  const liveGrants = () =>
    db
      .select()
      .from(connectionOperationGrants)
      .all()
      .filter((g) => g.subjectType === 'extension' && g.revokedAt === null);

  it('reads a declared, granted operation, with no token in the answer', async () => {
    expect(approve()).toMatchObject({ granted: [LIST, GET], notRead: [UPDATE], missing: [] });
    await expect(reader.read(installOf(), LIST, { first: 5 })).resolves.toEqual({
      status: 'success',
      data: { projects: [] },
    });
    expect(provider.commands).toHaveLength(1);
    expect(provider.commands[0]).toMatchObject({ arguments: { first: 5 } });
  });

  it('QA 1: refuses an undeclared operation, and the app is never called', async () => {
    approve();
    await expect(reader.read(installOf(), 'LINEAR_DELETE_EVERYTHING', {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_DECLARED',
    });
    expect(provider.commands).toHaveLength(0);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(0);
  });

  it('QA 2: never grants or runs a write, even one the manifest declares', async () => {
    approve();
    expect(
      liveGrants()
        .map((g) => g.operationRevisionId)
        .sort()
    ).toEqual(['rev-get', 'rev-list']);
    await expect(reader.read(installOf(), UPDATE, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
    // The database refuses a forged write grant too (M5).
    expect(() =>
      db
        .insert(connectionOperationGrants)
        .values({
          id: 'forged',
          subjectType: 'extension',
          subjectId: 'flow-owner',
          agentId: null,
          extensionId: 'flow-owner',
          connectionId: CONNECTION,
          operationRevisionId: 'rev-update',
          createdBy: 'nobody',
          createdAt: NOW,
        })
        .run()
    ).toThrow(/read operations only/);
    expect(provider.commands).toHaveLength(0);
  });

  it('QA 3: revoking stops the next read', async () => {
    approve();
    await expect(reader.read(installOf(), LIST, {})).resolves.toMatchObject({ status: 'success' });
    expect(approvals.revokeForConnection('flow-owner', CONNECTION)).toBe(1);
    await expect(reader.read(installOf(), LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
    expect(liveGrants()).toHaveLength(0);
  });

  it('QA 3: a revoke between the check and the send stops the send', async () => {
    approve();
    provider.beforeDispatch = () => {
      approvals.revokeForConnection('flow-owner', CONNECTION);
    };
    await expect(reader.read(installOf(), LIST, {})).resolves.toMatchObject({
      status: 'error',
      code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
    });
  });

  it('QA 4: uninstall revokes every approval and grant the extension holds', () => {
    approve();
    approve(installOf({ scope: 'local', realPath: '/work/repo/.dork/extensions/flow-owner' }));
    expect(approvals.revoke('flow-owner')).toBe(2);
    expect(approvals.liveApprovalsOf('flow-owner')).toEqual([]);
    expect(liveGrants()).toHaveLength(0);
  });

  it('N1: refuses once the files differ from the ones a person approved', async () => {
    approve();
    await expect(
      reader.read(installOf({ liveFilesDigest: 'sha256:files-2' }), LIST, {})
    ).rejects.toMatchObject({ code: 'EXTENSION_CONNECTION_NOT_GRANTED' });
  });

  it('an operation a later manifest adds stays refused until a person approves it', async () => {
    approve(
      installOf({ declarations: [{ service: 'linear', access: 'read', operations: [LIST] }] })
    );
    await expect(reader.read(installOf(), GET, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
    await expect(reader.read(installOf(), LIST, {})).resolves.toMatchObject({ status: 'success' });
    expect(provider.commands).toHaveLength(1);
  });

  it('C2: a revoke while the app answers keeps the answer from the extension', async () => {
    approve();
    provider.results.push({ status: 'success', data: { leaked: 'after-revoke' } });
    provider.afterDispatch = () => {
      approvals.revokeForConnection('flow-owner', CONNECTION);
    };
    await expect(reader.read(installOf(), LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toMatchObject([
      { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_AFTER_DISPATCH' },
    ]);
  });

  it('C2: a child that stops while the app answers gets nothing, and a stop cancels the read', async () => {
    approve();
    let running = true;
    provider.afterDispatch = () => {
      running = false;
    };
    await expect(
      reader.read(installOf({ isolated: () => running }), LIST, {})
    ).rejects.toMatchObject({ code: 'EXTENSION_CONNECTION_NOT_GRANTED' });
    const stop = new AbortController();
    let cancelled: boolean | undefined;
    provider.afterDispatch = (command) => {
      stop.abort();
      cancelled = command.signal.aborted;
    };
    await expect(reader.read(installOf(), LIST, {}, stop.signal)).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
    expect(cancelled).toBe(true);
  });

  it('E: a copy at the same path with the same origin but another scope gets nothing', async () => {
    approve();
    await expect(reader.read(installOf({ scope: 'local' }), LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
  });

  it('G: with the database guard gone, the code still refuses a write grant', async () => {
    approve();
    db.run(sql`DROP TRIGGER connection_operation_grants_extension_read_only_insert`);
    db.insert(connectionOperationGrants)
      .values({
        id: 'forged',
        subjectType: 'extension',
        subjectId: 'flow-owner',
        agentId: null,
        extensionId: 'flow-owner',
        connectionId: CONNECTION,
        operationRevisionId: 'rev-update',
        createdBy: 'nobody',
        createdAt: NOW,
      })
      .run();
    await expect(reader.read(installOf(), UPDATE, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_READ',
    });
    expect(provider.commands).toHaveLength(0);
  });

  it("H: one extension can't read through another's grant on the same account", async () => {
    approve();
    const other = installOf({ extensionId: 'other-ext' });
    db.insert(extensionConnectionApprovals)
      .values({
        id: 'approval-other',
        extensionId: 'other-ext',
        installScope: other.scope,
        installRealPath: other.realPath,
        installOrigin: 'trusted_source',
        originSource: 'dork-labs/marketplace',
        approvedFilesDigest: other.liveFilesDigest!,
        approvedVersion: other.version,
        service: 'linear',
        connectionId: CONNECTION,
        approvedOperationsDigest: 'sha256:none',
        approvedBy: 'owner',
        approvedAt: NOW,
      })
      .run();
    await expect(reader.read(other, LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_GRANTED',
    });
    expect(provider.commands).toHaveLength(0);
  });

  it('N2: a same-id copy elsewhere, or with another origin, gets nothing', async () => {
    approve();
    for (const other of [
      installOf({ scope: 'local', realPath: '/work/repo/.dork/extensions/flow-owner' }),
      installOf({ realPath: '/home/me/.dork/extensions/FLOW-OWNER' }),
      installOf({ origin: 'digest_pinned', originSource: undefined }),
    ]) {
      await expect(reader.read(other, LIST, {})).rejects.toMatchObject({
        code: 'EXTENSION_CONNECTION_NOT_GRANTED',
      });
    }
  });

  it('P4-2: grants stay while another live approval of the extension covers the account', () => {
    approve();
    const local = installOf({ scope: 'local', realPath: '/work/repo/.dork/extensions/flow-owner' });
    approve(local);
    const [first] = approvals.liveApprovalsOf('flow-owner');
    approvals.revokeApproval(first!.id);
    expect(liveGrants()).toHaveLength(2);
    approvals.revoke('flow-owner', { scope: 'local', realPath: local.realPath });
    expect(liveGrants()).toHaveLength(0);
  });

  it('Q7: a copy with no trusted origin can be neither approved nor read', async () => {
    const pathTrust = installOf({ origin: null, originSource: undefined });
    expect(() => approve(pathTrust)).toThrow(
      expect.objectContaining({ code: 'EXTENSION_CONNECTION_NOT_ALLOWED' })
    );
    approve();
    await expect(reader.read(pathTrust, LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_ALLOWED',
    });
  });

  it('S2: refuses unless the copy runs isolated with sqlite refused', async () => {
    approve();
    await expect(reader.read(installOf({ isolated: () => false }), LIST, {})).rejects.toMatchObject(
      { code: 'EXTENSION_CONNECTION_NOT_ALLOWED' }
    );
    expect(provider.commands).toHaveLength(0);
  });

  it('Q5: refuses an answer over 8 MB rather than cutting it', async () => {
    approve();
    provider.results.push({ status: 'success', data: { blob: 'x'.repeat(8 * 1024 * 1024 + 1) } });
    await expect(reader.read(installOf(), LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_RESULT_TOO_LARGE',
    });
    expect(db.select().from(connectorUsageTerminalReceipts).all()).toEqual([
      expect.objectContaining({
        outcome: 'error',
        errorCode: 'EXTENSION_CONNECTION_RESULT_TOO_LARGE',
      }),
    ]);
  });

  it('S6 / P4-5: records the read under the extension, with no agent and an arguments hash', async () => {
    approve();
    await reader.read(installOf(), LIST, { first: 5 });
    const [attempt] = db.select().from(connectorUsageAttempts).all();
    expect(attempt).toMatchObject({
      surface: 'extension',
      actorKind: 'extension',
      actorId: 'flow-owner',
      agentId: null,
      sessionId: null,
      connectionId: CONNECTION,
      operationRevisionId: 'rev-list',
    });
    expect(attempt!.argumentsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The hash names the call without holding its arguments.
    expect(JSON.stringify(attempt)).not.toContain('"first"');
  });

  it('refuses arguments that do not match the operation input', async () => {
    approve();
    await expect(reader.read(installOf(), LIST, { first: 'five' })).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_INVALID_INPUT',
    });
    await expect(reader.read(installOf(), LIST, [] as never)).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_INVALID_INPUT',
    });
  });

  it('refuses an account reached through a DorkOS account, at approval and at read', async () => {
    approve();
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    await expect(reader.read(installOf(), LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_UNAVAILABLE',
    });
    expect(() => approve()).toThrow(
      expect.objectContaining({ code: 'EXTENSION_CONNECTION_UNAVAILABLE' })
    );
  });

  it('refuses while the account is paused or signed out', async () => {
    approve();
    db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION)).run();
    await expect(reader.read(installOf(), LIST, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_UNAVAILABLE',
    });
  });

  it('says what each declared service can do now', () => {
    expect(reader.status(installOf())).toEqual([{ service: 'linear', granted: false }]);
    approve();
    expect(reader.status(installOf())).toEqual([
      { service: 'linear', granted: true, accountLabel: 'Work Linear' },
    ]);
    expect(reader.status(installOf({ liveFilesDigest: 'sha256:files-2' }))).toEqual([
      { service: 'linear', granted: false },
    ]);
    db.update(connections)
      .set({ lifecycleState: 'disconnected' })
      .where(eq(connections.id, CONNECTION))
      .run();
    expect(reader.status(installOf())).toEqual([{ service: 'linear', granted: false }]);
  });

  it('re-approving the same install replaces its approval, one live row', () => {
    approve();
    approve();
    expect(
      db
        .select()
        .from(extensionConnectionApprovals)
        .all()
        .filter((row) => row.revokedAt === null)
    ).toHaveLength(1);
    expect(liveGrants()).toHaveLength(2);
  });
});
