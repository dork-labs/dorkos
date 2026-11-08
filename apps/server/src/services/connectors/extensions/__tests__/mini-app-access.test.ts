/**
 * The Connections page's view of mini apps' access (DOR-3547): what waits for
 * a person, what is allowed, and revoking. A real migrated database; made-up
 * data only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../registry.js';
import { ExtensionConnectionApprovalStore } from '../extension-connection-approvals.js';
import type { LiveExtensionInstall } from '../live-extension-install.js';
import { MiniAppAccess } from '../mini-app-access.js';

const NOW = '2026-11-08T12:00:00.000Z';
const CONNECTION = 'linear-work';
const LIST = 'LINEAR_LIST_LINEAR_PROJECTS';
const GET = 'LINEAR_GET_LINEAR_PROJECT';

/** A turned-on, isolated copy of `flow-owner` that reads Linear. */
function record(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'flow-owner',
    scope: 'global',
    origin: 'user',
    path: '/home/me/.dork/extensions/flow-owner',
    status: 'active',
    manifest: {
      id: 'flow-owner',
      name: 'Flow',
      version: '0.2.0',
      serverCapabilities: {
        serverEntry: './server.ts',
        runtime: 'subprocess',
        connections: [{ service: 'linear', access: 'read', operations: [LIST, GET] }],
      },
    },
    ...overrides,
  } as ExtensionRecord;
}

/** The broker's facts for a copy, as the host would build them. */
function installFor(rec: ExtensionRecord, files = 'sha256:files-1'): LiveExtensionInstall {
  return {
    extensionId: rec.id,
    scope: rec.scope,
    realPath: rec.path,
    origin: 'trusted_source',
    originSource: 'dork-labs/marketplace',
    liveFilesDigest: files,
    version: rec.manifest.version,
    declarations: rec.manifest.serverCapabilities?.connections ?? [],
    isolated: () => false,
  };
}

describe('mini app access, for the Connections page', () => {
  let db: Db;
  let approvals: ExtensionConnectionApprovalStore;
  let records: ExtensionRecord[];
  let files: string;
  let access: MiniAppAccess;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
    });
    new ConnectorRegistry({ db }).register(provider);
    db.update(connectorProviderInstances)
      .set({ mode: 'byo', ownerKind: 'local_install', ownerId: 'install-a' })
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
    db.insert(connectorOperationRevisions)
      .values(
        [LIST, GET].map((slug) => ({
          id: `rev-${slug}`,
          providerInstanceId: provider.instanceId,
          toolkit: 'linear',
          operationSlug: slug,
          toolkitVersion: '1',
          schemaHash: `sha256:${slug}`,
          capabilityClassification: 'read' as const,
          retryPolicy: 'never' as const,
          inputSchemaJson: '{"type":"object"}',
          discoveredAt: NOW,
        }))
      )
      .run();
    approvals = new ExtensionConnectionApprovalStore(db, () => new Date(NOW));
    records = [record()];
    files = 'sha256:files-1';
    access = new MiniAppAccess({
      db,
      approvals,
      extensions: () => records,
      installOf: (rec) => installFor(rec, files),
    });
  });

  const approve = (rec = record()) =>
    approvals.approve({
      install: installFor(rec),
      service: 'linear',
      connectionId: CONNECTION,
      approvedBy: 'owner',
    });

  it('lists a declared app nobody approved as waiting, with its reads', () => {
    expect(access.list()).toEqual({
      waiting: [
        {
          extensionId: 'flow-owner',
          extensionName: 'Flow',
          service: 'linear',
          operations: [LIST, GET],
          reason: 'new',
        },
      ],
      allowed: [],
    });
  });

  it('lists a yes as allowed, with the account name, and nothing waiting', () => {
    const { approvalId } = approve();
    expect(access.list()).toEqual({
      waiting: [],
      allowed: [
        {
          approvalId,
          extensionId: 'flow-owner',
          extensionName: 'Flow',
          service: 'linear',
          connectionId: CONNECTION,
          connectionLabel: 'Work Linear',
          approvedAt: NOW,
        },
      ],
    });
  });

  it('waits again when the files change', () => {
    approve();
    files = 'sha256:files-2';
    expect(access.list().waiting).toMatchObject([{ reason: 'files_changed' }]);
  });

  it('waits again when the declared reads change', () => {
    approve(
      record({
        manifest: {
          ...record().manifest,
          serverCapabilities: {
            serverEntry: './server.ts',
            runtime: 'subprocess',
            connections: [{ service: 'linear', access: 'read', operations: [LIST] }],
          },
        },
      })
    );
    expect(access.list().waiting).toMatchObject([{ reason: 'operations_changed' }]);
  });

  it('lists nothing for a copy that is off, runs inside DorkOS, or has no trusted origin', () => {
    for (const rec of [
      record({ status: 'disabled' }),
      record({
        manifest: {
          ...record().manifest,
          serverCapabilities: {
            serverEntry: './server.ts',
            connections: [{ service: 'linear', access: 'read', operations: [LIST] }],
          },
        },
      }),
    ]) {
      records = [rec];
      expect(access.list().waiting).toEqual([]);
    }
    records = [record()];
    access = new MiniAppAccess({
      db,
      approvals,
      extensions: () => records,
      installOf: (rec) => ({ ...installFor(rec), origin: null }),
    });
    expect(access.list().waiting).toEqual([]);
  });

  it('revoke takes the yes and its grants back, once', () => {
    const { approvalId } = approve();
    expect(access.revoke(approvalId)).toBe(true);
    expect(access.revoke(approvalId)).toBe(false);
    expect(access.list().allowed).toEqual([]);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .all()
        .filter((g) => g.subjectType === 'extension' && g.revokedAt === null)
    ).toEqual([]);
  });

  it('names a yes by its id when the mini app is no longer installed', () => {
    approve();
    records = [];
    expect(access.list().allowed).toMatchObject([{ extensionName: 'flow-owner' }]);
  });

  it('describes a waiting read for the decide page, with its accounts and files', () => {
    expect(access.describe('flow-owner', 'linear')).toEqual({
      waiting: expect.objectContaining({ extensionId: 'flow-owner', service: 'linear' }),
      filesDigest: 'sha256:files-1',
      accounts: [{ connectionId: CONNECTION, label: 'Work Linear' }],
    });
    expect(access.describe('flow-owner', 'gmail')).toBeUndefined();
    expect(access.describe('someone-else', 'linear')).toBeUndefined();
  });

  it('lists no account reached through a DorkOS account', () => {
    db.update(connectorProviderInstances).set({ mode: 'managed' }).run();
    expect(access.describe('flow-owner', 'linear')?.accounts).toEqual([]);
  });

  it('approves the files the page showed, and refuses once they changed', () => {
    const input = {
      extensionId: 'flow-owner',
      service: 'linear',
      connectionId: CONNECTION,
      filesDigest: 'sha256:files-1',
      approvedBy: 'local',
    };
    files = 'sha256:files-2';
    expect(() => access.approve(input)).toThrow(/changed since the page opened/);
    files = 'sha256:files-1';
    expect(access.approve(input).granted).toEqual([LIST, GET]);
    expect(access.list().waiting).toEqual([]);
    expect(() => access.approve(input)).toThrow(/Nothing waits/);
  });
});
