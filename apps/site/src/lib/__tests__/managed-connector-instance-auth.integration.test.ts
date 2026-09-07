/**
 * @vitest-environment node
 */
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
  sendDeleteAccountVerification: vi.fn().mockResolvedValue(undefined),
}));

import { createAuth, type Auth } from '../auth';
import { INSTANCE_KEY_PREFIX } from '../instance-descriptor';
import {
  createInstanceApiKey,
  handleHeartbeat,
  verifyManagedConnectorInstance,
} from '../instance-service';

type MemoryRow = Record<string, unknown>;

const OWNER_ID = 'owner-1';
const DESCRIPTOR = {
  name: "Kai's MacBook",
  platform: 'darwin',
  dorkosVersion: '0.4.2',
};

function bearerRequest(key: string): Request {
  return new Request('http://localhost/api/instances/connectors', {
    headers: { authorization: `Bearer ${key}` },
  });
}

function heartbeatRequest(key: string): Request {
  return new Request('http://localhost/api/instances/heartbeat', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(DESCRIPTOR),
  });
}

describe('managed connector instance authentication', () => {
  let auth: Auth;
  let memory: Record<string, MemoryRow[]>;

  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret-123';
  });

  afterAll(() => {
    delete process.env.BETTER_AUTH_SECRET;
  });

  beforeEach(() => {
    memory = {
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
      deviceCode: [],
      instance: [],
      auditLog: [],
    };
    auth = createAuth(memoryAdapter(memory));
  });

  it('mints one live instance key with every exact managed connector permission', async () => {
    const linked = await createInstanceApiKey(auth, {
      userId: OWNER_ID,
      descriptor: DESCRIPTOR,
    });
    const request = bearerRequest(linked.key);

    await expect(verifyManagedConnectorInstance(auth, request, 'authority')).resolves.toMatchObject(
      {
        status: 'ok',
        ownerId: OWNER_ID,
        instanceId: linked.instanceId,
      }
    );
    await expect(verifyManagedConnectorInstance(auth, request, 'execute')).resolves.toMatchObject({
      status: 'ok',
      ownerId: OWNER_ID,
      instanceId: linked.instanceId,
    });
    await expect(verifyManagedConnectorInstance(auth, request, 'usage')).resolves.toMatchObject({
      status: 'ok',
      ownerId: OWNER_ID,
      instanceId: linked.instanceId,
    });
  });

  it('keeps an old link usable while requiring an explicit connector permission upgrade', async () => {
    const linked = await createInstanceApiKey(auth, {
      userId: OWNER_ID,
      descriptor: DESCRIPTOR,
    });
    const legacy = await auth.api.createApiKey({
      body: {
        userId: OWNER_ID,
        name: 'Legacy linked instance',
        prefix: INSTANCE_KEY_PREFIX,
        metadata: {
          instanceId: linked.instanceId,
          ...DESCRIPTOR,
          scope: 'instance',
        },
        permissions: { instance: ['link'] },
        rateLimitEnabled: false,
      },
    });

    await expect(
      verifyManagedConnectorInstance(auth, bearerRequest(legacy.key), 'authority')
    ).resolves.toEqual({ status: 'permission_upgrade_required' });

    const heartbeat = await handleHeartbeat(auth, heartbeatRequest(legacy.key));
    expect(heartbeat.status).toBe(200);
  });

  it('rejects a key that lacks the instance link marker even when metadata looks valid', async () => {
    const linked = await createInstanceApiKey(auth, {
      userId: OWNER_ID,
      descriptor: DESCRIPTOR,
    });
    const unlinked = await auth.api.createApiKey({
      body: {
        userId: OWNER_ID,
        name: 'Program key',
        prefix: INSTANCE_KEY_PREFIX,
        metadata: {
          instanceId: linked.instanceId,
          ...DESCRIPTOR,
          scope: 'instance',
        },
        permissions: { connectors: ['authority'] },
        rateLimitEnabled: false,
      },
    });

    await expect(
      verifyManagedConnectorInstance(auth, bearerRequest(unlinked.key), 'authority')
    ).resolves.toEqual({ status: 'unauthorized' });
  });

  it('rejects revoked and cross-owner instance registry rows', async () => {
    const linked = await createInstanceApiKey(auth, {
      userId: OWNER_ID,
      descriptor: DESCRIPTOR,
    });
    const request = bearerRequest(linked.key);
    const row = memory.instance.find((candidate) => candidate.id === linked.instanceId);
    expect(row).toBeDefined();

    row!.userId = 'different-owner';
    await expect(verifyManagedConnectorInstance(auth, request, 'execute')).resolves.toEqual({
      status: 'unauthorized',
    });

    row!.userId = OWNER_ID;
    row!.revokedAt = new Date();
    await expect(verifyManagedConnectorInstance(auth, request, 'execute')).resolves.toEqual({
      status: 'unauthorized',
    });
  });
});
