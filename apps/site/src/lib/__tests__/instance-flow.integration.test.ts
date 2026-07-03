/**
 * @vitest-environment node
 */
import { memoryAdapter } from 'better-auth/adapters/memory';
import { toNextJsHandler } from 'better-auth/next-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Resend seam mocked so no test performs real email/network I/O.
vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
}));

import { createAuth, type Auth } from '../auth';
import {
  INSTANCE_CLIENT_ID,
  INSTANCE_KEY_PREFIX,
  encodeInstanceDescriptor,
} from '../instance-descriptor';
import {
  getPendingInstance,
  handleHeartbeat,
  listInstances,
  revokeInstance,
} from '../instance-service';

const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';
const ORIGIN = 'http://localhost:3000';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const DESCRIPTOR = { name: "Kai's MacBook", platform: 'darwin', dorkosVersion: '0.4.2' };

type MemoryRow = Record<string, unknown>;

/** A JSON POST against the Better Auth Next.js handler. */
function authPost(
  handler: (r: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  return handler(
    new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  );
}

/** Extract the `name=value` cookie pairs from a response's Set-Cookie headers. */
function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('device-link instance flow (integration)', () => {
  const memory: Record<string, MemoryRow[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    apikey: [],
    deviceCode: [],
    instance: [],
  };
  let auth: Auth;
  let POST: (request: Request) => Promise<Response>;
  let cookie: string;
  let userId: string;
  let issuedKey = '';

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret-123';
    auth = createAuth(memoryAdapter(memory));
    POST = toNextJsHandler(auth).POST;

    // Sign up → verify → sign in, capturing the owner's session cookie + id.
    await authPost(POST, '/api/auth/sign-up/email', {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      name: OWNER_NAME,
    });
    memory.user[0].emailVerified = true;
    const signIn = await authPost(POST, '/api/auth/sign-in/email', {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    cookie = cookieFrom(signIn);
    userId = memory.user[0].id as string;
  });

  afterAll(() => {
    delete process.env.BETTER_AUTH_SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Request a fresh device code, returning its codes. */
  async function requestCode() {
    const res = await authPost(POST, '/api/auth/device/code', {
      client_id: INSTANCE_CLIENT_ID,
      scope: encodeInstanceDescriptor(DESCRIPTOR),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
  }

  /** Poll the device-token endpoint once. */
  function pollToken(deviceCode: string) {
    return authPost(POST, '/api/auth/device/token', {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: INSTANCE_CLIENT_ID,
    });
  }

  it('returns device_code, user_code, and a /activate verification URI', async () => {
    const codes = await requestCode();
    expect(codes.device_code).toBeTruthy();
    expect(codes.user_code).toHaveLength(8);
    expect(codes.verification_uri).toContain('/activate');
    expect(codes.interval).toBe(5);
  });

  it('returns authorization_pending while the code is unapproved', async () => {
    const codes = await requestCode();
    const res = await pollToken(codes.device_code);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('authorization_pending');
  });

  it('yields a scoped API key (not a session) on approval by a signed-in user', async () => {
    const codes = await requestCode();

    // /activate claims the code for the signed-in account and shows the instance.
    const pending = await getPendingInstance(auth, { userCode: codes.user_code, userId });
    expect(pending.status).toBe('pending');
    expect(pending.name).toBe(DESCRIPTOR.name);
    expect(pending.platform).toBe('darwin');

    const approve = await authPost(
      POST,
      '/api/auth/device/approve',
      { userCode: codes.user_code },
      cookie
    );
    expect(approve.status).toBe(200);

    const tokenRes = await pollToken(codes.device_code);
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    // The polling instance receives a scoped API key, prefixed + marked.
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toBe('instance');
    expect(token.access_token.startsWith(INSTANCE_KEY_PREFIX)).toBe(true);

    // The issued credential is an API key, never a browser session.
    const apiKeyRow = memory.apikey.find((k) => (k.referenceId as string) === userId);
    expect(apiKeyRow).toBeDefined();

    // Stash for the heartbeat/revoke tests.
    issuedKey = token.access_token;
  });

  it('denies the flow when the user denies (access_denied)', async () => {
    const codes = await requestCode();
    await getPendingInstance(auth, { userCode: codes.user_code, userId });
    const deny = await authPost(
      POST,
      '/api/auth/device/deny',
      { userCode: codes.user_code },
      cookie
    );
    expect(deny.status).toBe(200);

    const res = await pollToken(codes.device_code);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('access_denied');
  });

  it('expires the code after 30 minutes (expired_token)', async () => {
    const codes = await requestCode();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    const res = await pollToken(codes.device_code);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('expired_token');
  });

  it('authenticates the heartbeat with the issued key and updates lastSeenAt', async () => {
    const first = await handleHeartbeat(auth, heartbeatRequest(issuedKey, DESCRIPTOR));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { instanceId: string; lastSeenAt: string };
    const instanceId = firstBody.instanceId;
    expect(instanceId).toBeTruthy();

    const rows = await listInstances(auth, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(DESCRIPTOR.name);
    const firstSeen = rows[0].lastSeenAt;

    // A second heartbeat updates the SAME row (no duplicate) and refreshes fields.
    await new Promise((r) => setTimeout(r, 5));
    const second = await handleHeartbeat(
      auth,
      heartbeatRequest(issuedKey, { name: 'Renamed', platform: 'linux', dorkosVersion: '0.5.0' })
    );
    expect(second.status).toBe(200);
    const after = await listInstances(auth, userId);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('Renamed');
    expect(after[0].platform).toBe('linux');
    expect(after[0].lastSeenAt >= firstSeen).toBe(true);
  });

  it('401s the heartbeat after revocation and stamps revokedAt', async () => {
    const rows = await listInstances(auth, userId);
    const instanceId = rows[0].id;

    const result = await revokeInstance(auth, { userId, instanceId });
    expect(result.ok).toBe(true);

    // Same key now fails — the local instance detects the unlink via 401.
    const res = await handleHeartbeat(auth, heartbeatRequest(issuedKey, DESCRIPTOR));
    expect(res.status).toBe(401);

    const after = await listInstances(auth, userId);
    expect(after[0].revokedAt).not.toBeNull();
  });

  it('rejects a heartbeat with a missing or bogus key', async () => {
    const noKey = await handleHeartbeat(
      auth,
      new Request(`${ORIGIN}/api/instances/heartbeat`, { method: 'POST', body: '{}' })
    );
    expect(noKey.status).toBe(401);
    const bogus = await handleHeartbeat(
      auth,
      heartbeatRequest('dork_inst_not_a_real_key', DESCRIPTOR)
    );
    expect(bogus.status).toBe(401);
  });
});

/** Build a heartbeat request carrying a Bearer instance key + descriptor body. */
function heartbeatRequest(
  key: string,
  descriptor: { name: string; platform: string; dorkosVersion: string }
): Request {
  return new Request('http://localhost:3000/api/instances/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(descriptor),
  });
}
