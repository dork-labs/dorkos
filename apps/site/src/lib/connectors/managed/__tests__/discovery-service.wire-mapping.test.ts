/** @vitest-environment node */
/**
 * The managed discovery wire is strict, and the provider's own shapes carry
 * more than it allows: a toolkit's logo and description, an operation's private
 * revision reference and display hints. These run the real service functions
 * and the real wire schemas over such shapes, so a spread that forwards an
 * extra field fails here instead of taking a live app's discovery down.
 */
import { PGlite } from '@electric-sql/pglite';
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as siteSchema from '@/db/schema';
import {
  registerManagedProvider,
  resolveConnectorTenant,
  type ManagedConnectorDatabase,
} from '../authority-service';
import type { ManagedConnectorConfig } from '../config';
import {
  listManagedConnectorCatalog,
  listManagedOperationSchemas,
  ManagedRequestShapeError,
  resolveManagedToolkitVersion,
} from '../discovery-service';
import { provisionManagedTestDatabase } from './managed-database-fixture';

// Booting PGlite and replaying the managed migrations costs seconds under load
// (the sibling integration suites measured the same 5-15s band).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const config: ManagedConnectorConfig = {
  enabled: true,
  liveReady: true,
  projectApiKey: 'project-fixture',
  callbackOrigin: 'https://dorkos.example',
  authConfigByToolkit: { gmail: 'ac_gmail' },
};

const signal = new AbortController().signal;

/** Only the methods a case calls; the provider types brand ids a fixture need not. */
function operationsClient(overrides: object): ComposioOperationClient {
  return overrides as ComposioOperationClient;
}

describe('managed catalog wire mapping', () => {
  it('drops a toolkit’s logo and description instead of failing the page', async () => {
    const page = await listManagedConnectorCatalog({
      config,
      rawRequest: { version: 1, limit: 10 },
      signal,
      operations: operationsClient({
        listToolkitPage: async () => ({
          status: 'ok',
          truncated: false,
          toolkits: [
            {
              slug: 'gmail',
              displayName: 'Gmail',
              authKind: 'oauth2',
              logoUrl: 'https://logos.composio.dev/api/gmail',
              description: 'Send and read email.',
            },
          ],
        }),
      }),
    });
    expect(page.toolkits).toHaveLength(1);
    expect(page.toolkits[0]).toMatchObject({ slug: 'gmail', displayName: 'Gmail' });
    expect(JSON.stringify(page)).not.toContain('logos.composio.dev');
    expect(page.toolkits[0]).not.toHaveProperty('logoUrl');
    expect(page.toolkits[0]).not.toHaveProperty('description');
  });

  it('trims a long display name and falls back to the slug for a blank one', async () => {
    const page = await listManagedConnectorCatalog({
      config,
      rawRequest: { version: 1, limit: 10 },
      signal,
      operations: operationsClient({
        listToolkitPage: async () => ({
          status: 'ok',
          truncated: false,
          toolkits: [
            { slug: 'long', displayName: 'L'.repeat(250), authKind: 'api-key' },
            { slug: 'blank', displayName: '   ', authKind: 'none' },
          ],
        }),
      }),
    });
    expect(page.toolkits[0]!.displayName).toBe('L'.repeat(200));
    expect(page.toolkits[1]!.displayName).toBe('blank');
  });

  it('tags a malformed request as the caller’s fault', async () => {
    await expect(
      listManagedConnectorCatalog({
        config,
        rawRequest: { version: 1, limit: 1_000 },
        signal,
        operations: operationsClient({}),
      })
    ).rejects.toBeInstanceOf(ManagedRequestShapeError);
  });
});

describe('managed toolkit version wire mapping', () => {
  it('forwards only the wire fields of a resolved version', async () => {
    const answer = await resolveManagedToolkitVersion({
      rawRequest: { version: 1, toolkit: 'gmail' },
      signal,
      operations: operationsClient({
        resolveToolkitVersion: async () =>
          ({
            status: 'ok',
            toolkit: 'gmail',
            toolkitVersion: '20260901_00',
            // A field a later provider version might add to its own result.
            deprecatedAt: '2026-09-01',
          }) as never,
      }),
    });
    expect(answer).toEqual({
      version: 1,
      status: 'ok',
      toolkit: 'gmail',
      toolkitVersion: '20260901_00',
    });
  });

  it('forwards an unsupported answer with its reason', async () => {
    const answer = await resolveManagedToolkitVersion({
      rawRequest: { version: 1, toolkit: 'gmail' },
      signal,
      operations: operationsClient({
        resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'No version.' }),
      }),
    });
    expect(answer).toEqual({ version: 1, status: 'unsupported', reason: 'No version.' });
  });
});

describe('managed toolkit version reason', () => {
  it('caps an upstream reason at the wire limit instead of failing the answer', async () => {
    const answer = await resolveManagedToolkitVersion({
      rawRequest: { version: 1, toolkit: 'gmail' },
      signal,
      operations: operationsClient({
        resolveToolkitVersion: async () => ({ status: 'unsupported', reason: 'r'.repeat(1_500) }),
      }),
    });
    expect(answer).toEqual({ version: 1, status: 'unsupported', reason: 'r'.repeat(1_000) });
  });
});

describe('managed operation wire mapping', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;

  beforeEach(async () => {
    client = new PGlite();
    await provisionManagedTestDatabase(client);
    db = drizzle(client, { schema: siteSchema }) as unknown as ManagedConnectorDatabase;
  });

  afterEach(async () => {
    await client.close();
  });

  it('keeps private and display-only operation fields off the wire', async () => {
    const tenant = await resolveConnectorTenant(db, 'owner-a');
    await registerManagedProvider(db, {
      tenantId: tenant.id,
      providerInstanceId: 'managed:composio',
      configurationDigest: 'digest-a',
    });
    const operation = {
      providerInstanceId: 'managed:composio',
      toolkit: 'gmail',
      operationSlug: 'GMAIL_FETCH_EMAILS',
      toolkitVersion: '20260901_00',
      schemaHash: 'sha256:schema-a',
      capabilityClassification: 'read' as const,
      retryPolicy: 'never' as const,
      inputSchema: { type: 'object' },
      providerRevisionRef: 'PRIVATE_REVISION_REF',
      displayName: 'Fetch emails',
      important: true,
    };
    const list = () =>
      listManagedOperationSchemas({
        db,
        principal: {
          ownerId: 'owner-a',
          instanceId: 'instance-a',
          tenantId: tenant.id,
          keyId: 'key-a',
        },
        rawRequest: {
          version: 1,
          toolkit: 'gmail',
          toolkitVersion: '20260901_00',
          limit: 100,
        },
        signal,
        operations: operationsClient({
          listOperationSchemas: async () => ({
            status: 'ok',
            page: { truncated: false, operations: [operation] },
          }),
        }),
      });

    // The first read inserts the revision; the second finds it current.
    for (const page of [await list(), await list()]) {
      if (page.status !== 'ok') throw new Error('Expected an operation page.');
      expect(page.operations).toHaveLength(1);
      const [wire] = page.operations;
      expect(wire).toMatchObject({ operationSlug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail' });
      expect(wire).not.toHaveProperty('providerRevisionRef');
      expect(wire).not.toHaveProperty('displayName');
      expect(wire).not.toHaveProperty('important');
      expect(JSON.stringify(page)).not.toContain('PRIVATE_REVISION_REF');
    }
  });
});
