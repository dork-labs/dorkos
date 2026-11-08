/**
 * The extension side of `ctx.connections` (DOR-3547): which copies may hold a
 * grant (Security Q7), the install facts the broker checks (P4-1), and that a
 * change of runtime or install revokes both the approval and its grants
 * (N3). Real migrated database, made-up rows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  extensionConnectionApprovals,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../../connectors/registry.js';
import { ConnectorUsageStore } from '../../../connectors/execution/usage-store.js';
import { ExtensionConnectionApprovalStore } from '../../../connectors/extensions/extension-connection-approvals.js';
import { ExtensionConnectionReader } from '../../../connectors/extensions/extension-connection-reader.js';
import { setExtensionConnectionServices } from '../../../connectors/extensions/extension-connections-seam.js';
import { createDataProviderContext } from '../../extension-server-api-factory.js';
import { approvalFor } from '../../pin/extension-content-pin.js';
import {
  extensionConnectionsFor,
  installOf,
  isolatedConnectionsFor,
  originOf,
  settleApprovals,
} from '../extension-connections-ctx.js';

const NOW = '2026-11-08T12:00:00.000Z';
const NO_APPROVALS = { approvedToRun: [], approvedSources: {} };

describe('extension connections, extension side', () => {
  let tmp: string;
  let folder: string;
  let db: Db;
  let approvals: ExtensionConnectionApprovalStore;

  /** A trusted-source copy of flow-owner that declares Linear reads. */
  const record = (overrides: Partial<ExtensionRecord> = {}): ExtensionRecord =>
    ({
      id: 'flow-owner',
      scope: 'global',
      origin: 'user',
      path: folder,
      status: 'enabled',
      trustedOrigin: { plugin: 'flow', source: 'dork-labs/marketplace' },
      currentDigest: 'sha256:files-1',
      manifest: {
        id: 'flow-owner',
        name: 'Flow',
        version: '0.2.0',
        serverCapabilities: {
          serverEntry: './server.ts',
          runtime: 'subprocess',
          connections: [
            { service: 'linear', access: 'read', operations: ['LINEAR_LIST_LINEAR_PROJECTS'] },
          ],
        },
      },
      ...overrides,
    }) as unknown as ExtensionRecord;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-connections-')));
    folder = path.join(tmp, 'flow-owner');
    fs.mkdirSync(folder);
    db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
    });
    const registry = new ConnectorRegistry({ db });
    registry.register(provider);
    db.update(connectorProviderInstances)
      .set({ mode: 'byo', ownerKind: 'local_install', ownerId: 'install-a' })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: 'linear-work',
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'ref',
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
      .values({
        id: 'rev-list',
        providerInstanceId: provider.instanceId,
        toolkit: 'linear',
        operationSlug: 'LINEAR_LIST_LINEAR_PROJECTS',
        toolkitVersion: '1',
        schemaHash: 'h',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{"type":"object"}',
        discoveredAt: NOW,
      })
      .run();
    approvals = new ExtensionConnectionApprovalStore(db, () => new Date(NOW));
    setExtensionConnectionServices({
      db,
      approvals,
      reader: new ExtensionConnectionReader(db, registry, approvals, new ConnectorUsageStore(db)),
    });
  });

  afterEach(() => {
    setExtensionConnectionServices(undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const approve = (rec = record()) =>
    approvals.approve({
      install: installOf(rec, NO_APPROVALS, () => true)!,
      service: 'linear',
      connectionId: 'linear-work',
      approvedBy: 'owner',
    });
  const liveRows = () => ({
    approvals: db
      .select()
      .from(extensionConnectionApprovals)
      .all()
      .filter((row) => row.revokedAt === null).length,
    grants: db
      .select()
      .from(connectionOperationGrants)
      .all()
      .filter((row) => row.subjectType === 'extension' && row.revokedAt === null).length,
  });

  describe('originOf (Q7)', () => {
    it('trusts core, a provable trusted source, and a copy pinned to the files a person approved', () => {
      expect(originOf(record({ origin: 'core' }), NO_APPROVALS)).toEqual({ origin: 'core' });
      expect(originOf(record(), NO_APPROVALS)).toEqual({
        origin: 'trusted_source',
        source: 'dork-labs/marketplace',
      });
      const pinned = record({ trustedOrigin: undefined });
      expect(
        originOf(pinned, {
          approvedToRun: ['flow-owner'],
          approvedSources: {
            'flow-owner': {
              path: folder,
              digest: 'sha256:files-1',
              personApprovedDigest: 'sha256:files-1',
            },
          },
        })
      ).toEqual({ origin: 'digest_pinned' });
    });

    it('trusts no path-trust, dev-link, changed or merely-approved copy', () => {
      const plain = record({ trustedOrigin: undefined });
      expect(originOf(plain, NO_APPROVALS)).toEqual({ origin: null });
      // Path trust: an agent-built copy approved by its author folder, not its files.
      expect(
        originOf(plain, {
          approvedToRun: ['flow-owner'],
          approvedSources: {
            'flow-owner': { path: folder, authorHome: '/agents/ana', grants: 'sha256:g' },
          },
        })
      ).toEqual({ origin: null });
      expect(originOf(record({ devLink: { path: folder } }), NO_APPROVALS)).toEqual({
        origin: null,
      });
      expect(originOf(record({ originProblem: 'changed' }), NO_APPROVALS)).toEqual({
        origin: null,
      });
    });

    it('C1: a digest yes no person gave is no origin, and a person approving lifts it', () => {
      const plain = record({ trustedOrigin: undefined });
      const withSource = (source: Record<string, unknown>) => ({
        approvedToRun: ['flow-owner'],
        approvedSources: {
          'flow-owner': {
            path: folder,
            digest: 'sha256:files-1',
            personApprovedDigest: 'sha256:files-1',
            ...source,
          },
        },
      });
      // Written by create_extension on a Trusted install, exactly as the scaffold writes it.
      expect(originOf(plain, withSource({ autoApprovedBy: 'create_extension' }))).toEqual({
        origin: null,
      });
      // DorkOS pinned an old path approval to the files it found after an upgrade.
      expect(originOf(plain, withSource({ pinnedOnFirstUse: NOW }))).toEqual({ origin: null });
      // A person's approveToRun rewrites the source without either stamp.
      expect(originOf(plain, withSource({}))).toEqual({ origin: 'digest_pinned' });
    });

    it("C1: only a person's own pin counts; every pin DorkOS wrote itself fails closed", () => {
      const plain = record({ trustedOrigin: undefined, currentDigest: 'sha256:files-1' });
      const copy = { ...plain, realPath: folder };
      const of = (source: object) =>
        originOf(plain, {
          approvedToRun: ['flow-owner'],
          approvedSources: { 'flow-owner': source as never },
        });
      // Security round 2, turned around: a create_extension approval from before
      // the stamp existed, written exactly as approveNewScaffold wrote it.
      const legacyScaffold = approvalFor(copy as never, { digest: 'sha256:files-1' })!;
      expect(legacyScaffold.autoApprovedBy).toBeUndefined();
      expect(of(legacyScaffold)).toEqual({ origin: null });
      // A path-trust copy a person approved, then re-pinned by path-trust-edits
      // to the files the agent last wrote ({ ...source, digest }).
      const personPathTrust = { path: folder, authorHome: '/agents/ana', grants: 'sha256:g' };
      expect(of({ ...personPathTrust, digest: 'sha256:files-1' })).toEqual({ origin: null });
      // A person's pin, then any later re-pin to other files: the old yes doesn't follow.
      const byPerson = approvalFor(copy as never, { digest: 'sha256:files-1', byPerson: true })!;
      expect(byPerson.personApprovedDigest).toBe('sha256:files-1');
      expect(of(byPerson)).toEqual({ origin: 'digest_pinned' });
      const repinned = { ...byPerson, digest: 'sha256:files-2' };
      expect(
        originOf(record({ trustedOrigin: undefined, currentDigest: 'sha256:files-2' }), {
          approvedToRun: ['flow-owner'],
          approvedSources: { 'flow-owner': repinned },
        })
      ).toEqual({ origin: null });
    });
  });

  it('builds the install from the real path of the folder (P4-1)', () => {
    const viaLink = path.join(tmp, 'link-to-flow');
    fs.symlinkSync(folder, viaLink);
    const install = installOf(record({ path: viaLink }), NO_APPROVALS, () => true);
    expect(install?.realPath).toBe(fs.realpathSync.native(folder));
    expect(install?.liveFilesDigest).toBe('sha256:files-1');
  });

  it('N3: moving the copy to run inside DorkOS revokes its approval and its grants', () => {
    approve();
    expect(liveRows()).toEqual({ approvals: 1, grants: 1 });
    settleApprovals(record(), NO_APPROVALS, false);
    expect(liveRows()).toEqual({ approvals: 0, grants: 0 });
    const [row] = db.select().from(extensionConnectionApprovals).all();
    expect(row!.revokedAt).toBe(NOW);
    const [grant] = db.select().from(connectionOperationGrants).all();
    expect(grant!.revokedAt).toBe(NOW);
  });

  it('N3: a start from another install, or with another origin, revokes; the same install keeps it', () => {
    approve();
    settleApprovals(record(), NO_APPROVALS, true);
    expect(liveRows()).toEqual({ approvals: 1, grants: 1 });
    settleApprovals(record({ trustedOrigin: undefined, origin: 'core' }), NO_APPROVALS, true);
    expect(liveRows()).toEqual({ approvals: 0, grants: 0 });
    approve();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    settleApprovals(record({ path: elsewhere }), NO_APPROVALS, true);
    expect(liveRows()).toEqual({ approvals: 0, grants: 0 });
  });

  it('gives ctx.connections only to a copy that declares connections', async () => {
    const none = record({
      manifest: {
        ...record().manifest,
        serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
      },
    } as Partial<ExtensionRecord>);
    expect(
      extensionConnectionsFor(
        none,
        () => NO_APPROVALS as never,
        () => true
      )
    ).toBeUndefined();
    const api = isolatedConnectionsFor(record(), () => NO_APPROVALS as never);
    expect(api.api).toBeDefined();
    // Before a host is attached, the S2 check can't pass.
    await expect(api.api!.read('LINEAR_LIST_LINEAR_PROJECTS', {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_ALLOWED',
    });
    api.attach({ sqliteRefused: true });
    await expect(api.api!.status()).resolves.toEqual([{ service: 'linear', granted: false }]);
  });

  it('T: an attached host whose sqlite check did not pass can read nothing', async () => {
    approve();
    const wired = isolatedConnectionsFor(record(), () => NO_APPROVALS as never);
    const host = { sqliteRefused: false };
    wired.attach(host);
    await expect(wired.api!.status()).resolves.toEqual([{ service: 'linear', granted: false }]);
    await expect(wired.api!.read('LINEAR_LIST_LINEAR_PROJECTS', {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_NOT_ALLOWED',
    });
    host.sqliteRefused = true;
    await expect(wired.api!.status()).resolves.toEqual([
      { service: 'linear', granted: true, accountLabel: 'Work Linear' },
    ]);
  });

  it('a stop signal reaches the reader through extensionConnectionsFor', async () => {
    const read = vi.fn(async () => ({ status: 'success' as const, data: null }));
    setExtensionConnectionServices({
      approvals,
      reader: { read, status: () => [] } as unknown as ExtensionConnectionReader,
    });
    const api = extensionConnectionsFor(
      record(),
      () => NO_APPROVALS as never,
      () => true
    )!;
    const stop = new AbortController();
    await api.read('LINEAR_LIST_LINEAR_PROJECTS', {}, stop.signal);
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      'LINEAR_LIST_LINEAR_PROJECTS',
      {},
      stop.signal
    );
  });

  it('S: a stopped instance reads nothing, and a read in flight is cancelled', async () => {
    let seen: AbortSignal | undefined;
    const read = vi.fn((_operation: string, _params?: unknown, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });
    const built = createDataProviderContext({
      extensionId: 'flow-owner',
      extensionDir: folder,
      dorkHome: tmp,
      connections: { read, status: async () => [] },
    });
    void built.ctx.connections!.read('LINEAR_LIST_LINEAR_PROJECTS', {});
    expect(seen?.aborted).toBe(false);
    built.dispose();
    expect(seen?.aborted).toBe(true);
    await expect(built.ctx.connections!.read('LINEAR_LIST_LINEAR_PROJECTS', {})).rejects.toThrow(
      /stopped/
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('an in-process ctx has no connections member at all', () => {
    const { ctx, releaseListeners } = createDataProviderContext({
      extensionId: 'flow-owner',
      extensionDir: folder,
      dorkHome: tmp,
    });
    expect(ctx.connections).toBeUndefined();
    expect('connections' in ctx).toBe(false);
    releaseListeners();
  });
});
