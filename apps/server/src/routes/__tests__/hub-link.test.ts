/**
 * @vitest-environment node
 *
 * `POST /api/hub/link` behind the real `/api` chain and session gate, on a
 * hub: a computer redeems its owner's code with no sign-in, the hub checks
 * the computer's signature with the computer's real key, stores it and
 * answers signed with its own key. Replayed, expired, wrong and browser-sent
 * requests are refused, a hub that cannot sign spends no code, and the gate's
 * exemption covers this one path and nothing beside it.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import {
  RELAY_LINK_CODE_TTL_MS,
  RelayLinkResponseSchema,
  type RelayLinkRequest,
} from '@dorkos/shared/session-relay-link';

const role = vi.hoisted(() => ({ value: 'hub' as 'hub' | 'computer' }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
// The front door is not what this file is about: it admits everything here.
vi.mock('../../services/core/hub/hub-serving.js', () => ({
  admitHubRequest: () => null,
  trackHubConnection: () => {},
  hubServingState: () => ({ state: 'starting' }),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: audit.record,
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  HUB_LINK_MAX_FAILURES,
  LinkCodeBook,
  linkComputer,
  readLinkedComputers,
  type HubLinkSigner,
  type LinkComputerInput,
} from '../../services/core/hub-relay/index.js';
import { pinnableKey } from '../../services/core/session-relay/channel.js';
import {
  signRelayLinkRequest,
  verifyRelayLinkResponse,
} from '../../services/core/session-relay/link-signature.js';
import { computerSigningKey } from '../../services/core/session-relay/pin-store.js';
import { createHubLinkRoutes, hubLinkBodyRule, type HubLinkRouteDeps } from '../hub-link.js';

const ORIGIN = 'https://me.dorkos.app';
const OWNER = { accountId: 'acct_owner', kind: 'person', name: 'Dorian' } as const;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-link-'));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const hubKey = generateKeyPairSync('ed25519').privateKey;
const hubSigner: HubLinkSigner = {
  sign: (data) => sign(null, data, hubKey),
  publicKey: pinnableKey(hubKey),
};
const clock = { now: 1_000_000 };
let codes = new LinkCodeBook(() => clock.now);

const deps = {
  isHub: () => role.value === 'hub',
  servingOrigin: vi.fn((): string | null => ORIGIN),
  signer: vi.fn((): HubLinkSigner | null => hubSigner),
  owner: vi.fn(() => ({ ownerAccountId: 'acct_owner', issuer: 'https://id.dorkos.ai' })),
  consume: (code: string) => codes.consume(code),
  link: vi.fn(async (_input: LinkComputerInput): Promise<unknown> => ({})),
} satisfies HubLinkRouteDeps;

const server = listeningServer(
  honoGroupListener(
    { path: '/api/hub/link', routes: createHubLinkRoutes(deps) },
    { bodyRules: [hubLinkBodyRule] }
  )
);

/** A computer's link request for `code`, signed with its real key. */
function linkRequest(code: string, overrides: Partial<RelayLinkRequest> = {}): RelayLinkRequest {
  return signRelayLinkRequest(
    {
      v: 1,
      code,
      computerId: 'mac-1',
      secretHash: randomBytes(32).toString('base64url'),
      computerName: 'Studio Mac',
      ...overrides,
    },
    ORIGIN,
    computerSigningKey(home)
  );
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return request(server)
    .post('/api/hub/link')
    .set(headers)
    .send(body as object);
}

beforeEach(() => {
  vi.clearAllMocks();
  role.value = 'hub';
  codes = new LinkCodeBook(() => clock.now);
  deps.servingOrigin.mockReturnValue(ORIGIN);
  deps.signer.mockReturnValue(hubSigner);
});

describe('linking with a good code', () => {
  it('stores the computer and answers signed with the hub key, no sign-in needed', async () => {
    const body = linkRequest(codes.mint(OWNER).code);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const answer = RelayLinkResponseSchema.parse(res.body);
    expect(answer).toMatchObject({
      hubKey: hubSigner.publicKey,
      ownerAccountId: 'acct_owner',
      issuer: 'https://id.dorkos.ai',
    });
    expect(verifyRelayLinkResponse(answer, body, ORIGIN)).toBe(true);
    // Verified over the origin the code named: another origin does not check out.
    expect(verifyRelayLinkResponse(answer, body, 'https://evil.example')).toBe(false);
    expect(deps.link).toHaveBeenCalledWith({
      computerId: 'mac-1',
      secretHash: body.secretHash,
      computerKey: pinnableKey(computerSigningKey(home)),
      computerName: 'Studio Mac',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub.relay.computer.link',
        outcome: 'ok',
        actor: OWNER,
        source: { surface: 'relay' },
        target: { type: 'computer', id: 'mac-1', name: 'Studio Mac' },
      })
    );
  });

  it('leaves the owner out when the hub does not know it', async () => {
    deps.owner.mockReturnValueOnce(null as never);
    const body = linkRequest(codes.mint().code);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body.ownerAccountId).toBeUndefined();
    expect(verifyRelayLinkResponse(RelayLinkResponseSchema.parse(res.body), body, ORIGIN)).toBe(
      true
    );
  });
});

describe('refusals', () => {
  const REFUSED = { error: 'That link code did not work. Make a new one.', code: 'LINK_REFUSED' };

  it('refuses a replayed code with the same 401', async () => {
    const code = codes.mint().code;
    expect((await post(linkRequest(code))).status).toBe(200);
    const again = await post(linkRequest(code));
    expect(again.status).toBe(401);
    expect(again.body).toEqual(REFUSED);
    expect(deps.link).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired code with the same 401', async () => {
    const code = codes.mint().code;
    clock.now += RELAY_LINK_CODE_TTL_MS;
    const res = await post(linkRequest(code));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(REFUSED);
  });

  it('refuses a guessed code with the same 401', async () => {
    codes.mint();
    const res = await post(linkRequest('0000000000000000'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(REFUSED);
  });

  it('refuses a forged signature with the same 401, and stores nothing', async () => {
    const body = linkRequest(codes.mint().code);
    // Signed by another key than the one the request names.
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = { ...body, computerKey: pinnableKey(other) };
    const res = await post(forged);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(REFUSED);
    expect(deps.link).not.toHaveBeenCalled();
  });

  it('refuses a signature over another hub origin', async () => {
    const code = codes.mint().code;
    const body = signRelayLinkRequest(
      { v: 1, code, computerId: 'mac-1', secretHash: 'h'.repeat(43), computerName: 'Mac' },
      'https://other.example',
      computerSigningKey(home)
    );
    expect((await post(body)).status).toBe(401);
  });

  it('refuses a request a browser sent (Sec-Fetch-Site), spending no code', async () => {
    const code = codes.mint().code;
    const res = await post(linkRequest(code), { 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect((await post(linkRequest(code))).status).toBe(200);
  });

  it('refuses a request carrying an Origin, spending no code', async () => {
    const code = codes.mint().code;
    const { port } = server.address() as AddressInfo;
    // The chain's CORS check or the route's own browser check; either way, no link.
    const res = await post(linkRequest(code), { Origin: `http://127.0.0.1:${port}` });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(deps.link).not.toHaveBeenCalled();
    expect((await post(linkRequest(code))).status).toBe(200);
  });

  it('refuses an Origin in the route itself, whatever the chain lets through', async () => {
    const res = await createHubLinkRoutes(deps).request('/', {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  it('answers 503 while the hub cannot sign, without spending the code', async () => {
    const code = codes.mint().code;
    deps.signer.mockReturnValue(null);
    expect((await post(linkRequest(code))).status).toBe(503);
    deps.signer.mockReturnValue(hubSigner);
    expect((await post(linkRequest(code))).status).toBe(200);
  });

  it('answers 503 while the hub does not serve, without spending the code', async () => {
    const code = codes.mint().code;
    deps.servingOrigin.mockReturnValue(null);
    expect((await post(linkRequest(code))).status).toBe(503);
    deps.servingOrigin.mockReturnValue(ORIGIN);
    expect((await post(linkRequest(code))).status).toBe(200);
  });

  it('answers 429 once too many wrong codes have come in, until the owner mints again', async () => {
    const code = codes.mint().code;
    for (let i = 0; i < HUB_LINK_MAX_FAILURES; i++) await post(linkRequest('0000000000000000'));
    expect((await post(linkRequest(code))).status).toBe(429);
    // A fresh code from the owner clears the count.
    expect((await post(linkRequest(codes.mint().code))).status).toBe(200);
  });

  it.each([
    ['a padded name', ' Studio Mac '],
    ['a direction mark', 'Studio\u200eMac'],
    ['a line separator', 'Studio\u2028Mac'],
  ])('refuses %s at the schema, before the code is spent', async (_label, computerName) => {
    const code = codes.mint().code;
    const res = await post(linkRequest(code, { computerName }));
    expect(res.status).toBe(400);
    expect((await post(linkRequest(code))).status).toBe(200);
  });

  it('answers 400 for a body that is not a link request', async () => {
    const res = await post({ v: 1, code: 'x' });
    expect(res.status).toBe(400);
  });

  it('answers 413 for a body over 4 KB', async () => {
    const res = await post({ padding: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('answers 409 when the store refuses the computer', async () => {
    deps.link.mockRejectedValueOnce(new Error('A hub serves at most 32 computers'));
    const res = await post(linkRequest(codes.mint().code));
    expect(res.status).toBe(409);
  });

  it('refuses a fresh code that names a linked computer under another key', async () => {
    const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-link-store-'));
    deps.link.mockImplementation((input) => linkComputer(input, storeHome));
    try {
      // Linked once, with the computer's own key.
      expect((await post(linkRequest(codes.mint().code))).status).toBe(200);
      const first = readLinkedComputers(storeHome);

      // Another key under the same id: refused, the record kept.
      const code = codes.mint().code;
      const intruder = signRelayLinkRequest(
        { v: 1, code, computerId: 'mac-1', secretHash: 'h'.repeat(43), computerName: 'Mac' },
        ORIGIN,
        generateKeyPairSync('ed25519').privateKey
      );
      const res = await post(intruder);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'That computer is already linked. Remove it first.',
        code: 'ALREADY_LINKED',
      });
      expect(readLinkedComputers(storeHome)).toEqual(first);
      // The code was spent.
      expect((await post(linkRequest(code))).status).toBe(401);

      // The same key relinks, rotating the secret.
      const relink = linkRequest(codes.mint().code);
      expect((await post(relink)).status).toBe(200);
      expect(readLinkedComputers(storeHome)[0]?.secretHash).toBe(relink.secretHash);
    } finally {
      deps.link.mockReset();
      deps.link.mockImplementation(async () => ({}));
      fs.rmSync(storeHome, { recursive: true, force: true });
    }
  });

  it('answers the /api 404 on a person`s own computer', async () => {
    role.value = 'computer';
    const res = await post(linkRequest(codes.mint().code));
    expect(res.status).toBe(404);
  });
});

describe('the session gate exemption', () => {
  it.each([
    ['a path below it', '/api/hub/link/extra'],
    ['a longer sibling', '/api/hub/linked'],
    ['a sibling under /api/hub', '/api/hub/computers'],
  ])('still asks %s for a sign-in', async (_label, target) => {
    const res = await request(server).post(target).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('covers the exact path, on a hub', async () => {
    const res = await post({});
    // Past the gate: the route's own 400, not the gate's 401.
    expect(res.status).toBe(400);
  });

  it('covers a trailing slash only because the router reads it as the same route', async () => {
    const res = await request(server).post('/api/hub/link/').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID');
  });
});
