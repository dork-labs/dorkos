/**
 * `/api/session-relay/passkeys` and the loopback return page (B4c): adding an
 * approvals passkey only through a statement `/start` issued at this computer
 * with the owner's password (Security's Must 2), and listing and removing them
 * at this computer only (Must 3). Behind the real `/api` chain with the
 * session gate stubbed open; the keys are a real file in a temporary data
 * folder, and every passkey comes from the soft authenticator (attestation
 * `none`).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  relay: true,
  /** This computer asks for a password, and the real login gate runs. */
  login: false,
  /** The TCP peer reads as another machine. */
  remotePeer: false,
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) =>
      key === 'auth'
        ? { enabled: state.login }
        : key === 'sessionRelay'
          ? { enabled: state.relay }
          : undefined
    ),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner' }),
  hasAnyUser: () => true,
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user: { userId: string } | undefined) => user?.userId === 'user_owner',
}));
vi.mock('../../lib/trusted-origins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trusted-origins.js')>()),
  getTunnelHosts: () => ['box.ngrok.app'],
  isLoopbackPeer: (address: string | undefined) => !state.remotePeer && address !== undefined,
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/core/auth/session-gate.js')>();
  return {
    ...actual,
    // Open, unless a test turns the password on: then the real gate decides.
    decideSessionGate: vi.fn(async (...args: Parameters<typeof actual.decideSessionGate>) =>
      state.login ? actual.decideSessionGate(...args) : { allowed: true }
    ),
  };
});
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { SoftAuthenticator, type SoftAttestation } from '@dorkos/test-utils/soft-authenticator';
import {
  decodeStepUpBase64url,
  decodeStepUpStatement,
  encodeStepUpBase64url,
  stepUpChallenge,
  type PasskeyEnrolStatementV1,
} from '@dork-labs/cloud-api';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { recordAudit } from '../../services/audit/audit-trail.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { markIngress, type IngressKind } from '../../services/core/remote/ingress-mark.js';
import {
  addApprovalKey,
  approvalKeysPath,
  approvalKeysUnreadable,
  readApprovalKeys,
  removeApprovalKey,
  removeDamagedApprovalKeys,
} from '../../services/core/session-relay/approval-key-store.js';
import {
  PasskeyEnrolment,
  approvalUserHandle,
  passkeyEnrolment,
} from '../../services/core/session-relay/passkeys/passkey-enrolment.js';
import {
  clearRelayPin,
  readRelayPin,
  writeRelayPin,
  type RelayPin,
} from '../../services/core/session-relay/pin-store.js';
import { createSessionRelayRoutes, type SessionRelayRouteDeps } from '../session-relay.js';
import { RELAY_PASSKEY_CSP, createRelayPasskeyPageRoutes } from '../relay-passkey-page.js';

const PASSWORD = 'correct horse';
const APPROVE = 'https://approve.dorkos.ai';
const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };

const PIN: RelayPin = {
  v: 2,
  computerId: 'computer-1',
  hubOrigin: 'https://me.dorkos.test',
  hubKey: randomBytes(32).toString('base64url'),
  relaySecret: randomBytes(32).toString('base64url'),
  pinnedAt: '2026-10-16T21:00:00.000Z',
  computerName: 'Studio Mac',
  level: 'chat',
  paused: false,
  issuer: 'https://cloud.dorkos.test',
  accountId: 'acct_owner',
};

const target = swappableServer();
let home: string;
let clock: Date;
let deps: SessionRelayRouteDeps;

function makeDeps(): SessionRelayRouteDeps {
  return {
    isHub: () => false,
    enabled: () => true,
    ownerExists: () => true,
    readPin: () => readRelayPin(home),
    updatePin: vi.fn(),
    clearPin: vi.fn(),
    closeRelay: vi.fn(),
    connected: () => true,
    link: vi.fn(),
    suggestedName: () => 'Studio Mac',
    checkPassword: vi.fn(async (password: string | undefined) =>
      password === PASSWORD ? 'ok' : password ? 'wrong' : 'required'
    ),
    presence: () => ({ active: false, devices: [] }),
    devices: () => [],
    passkeys: {
      readKeys: () => readApprovalKeys(home),
      keysUnreadable: () => approvalKeysUnreadable(home),
      addKey: (party, key, audit, stillLinked) =>
        addApprovalKey(party, key, audit, home, stillLinked),
      removeKey: (credentialId, audit) => removeApprovalKey(credentialId, audit, home),
      removeDamaged: (audit) => removeDamagedApprovalKeys(audit, home),
      enrolment: new PasskeyEnrolment(() => clock),
      audit: {
        owner: () => ({ accountId: 'acct_owner', kind: 'person', name: 'Owner' }),
        recordAudit: (input) => {
          const { actor: _owner, source: _relay, ...rest } = input;
          recordAudit({ ...rest, source: { surface: 'app' } });
        },
      },
    },
  } as SessionRelayRouteDeps;
}

let port = 0;

/** The routes and the return page behind the chain, as the gate would have seen the caller. */
function app(options: { user?: RequestUser; ingress?: IngressKind } = {}) {
  const server = target.mount(
    honoGroupListener(
      [
        { path: '/api/session-relay', routes: createSessionRelayRoutes(deps) },
        { path: '/', routes: createRelayPasskeyPageRoutes() },
      ],
      {
        before: async (c, next) => {
          if (options.user) c.set('user', options.user);
          if (options.ingress) markIngress(c.env.incoming, options.ingress);
          await next();
        },
      }
    )
  );
  port = (server.address() as AddressInfo).port;
  return server;
}

/** A started enrolment: the statement as sent, its bytes, and what it says. */
async function start(body: Record<string, unknown> = {}) {
  const res = await request(app())
    .post('/api/session-relay/passkeys/start')
    .send({ password: PASSWORD, label: 'MacBook passkey', ...body });
  expect(res.status).toBe(200);
  const bytes = decodeStepUpBase64url(res.body.statement);
  const statement = decodeStepUpStatement(bytes) as PasskeyEnrolStatementV1;
  return { res, encoded: res.body.statement as string, bytes, statement };
}

/** A registration response as `PublicKeyCredential.toJSON()` writes one. */
function registration(attestation: SoftAttestation) {
  return {
    id: attestation.credentialId,
    rawId: attestation.credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: attestation.clientDataJSON,
      attestationObject: attestation.attestationObject,
    },
    clientExtensionResults: {},
  };
}

/** A passkey for the statement's relying party and user. */
function authenticatorFor(statement: PasskeyEnrolStatementV1, alg: 'ES256' | 'Ed25519' = 'ES256') {
  return new SoftAuthenticator({
    rpId: statement.rpId,
    origin: statement.origin,
    userHandle: statement.userHandle,
    alg,
  });
}

/** The return page's own origin, as its script's `fetch` sends it. */
const pageOrigin = () => `http://127.0.0.1:${port}`;

function finish(statement: string, attestation: SoftAttestation) {
  return request(app())
    .post('/api/session-relay/passkeys/finish')
    .set('Origin', pageOrigin())
    .send({ statement, attestation: registration(attestation) });
}

/** Why the last refused finish was refused, as the audit log recorded it. */
function lastRefusal(): string | undefined {
  const refused = vi
    .mocked(recordAudit)
    .mock.calls.filter(([input]) => input.action === 'session-relay.passkey.add');
  return refused.at(-1)?.[0].error;
}

function auditActions(): string[] {
  return vi.mocked(recordAudit).mock.calls.map(([input]) => input.action);
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.relay = true;
  state.login = false;
  state.remotePeer = false;
  clock = new Date('2026-10-19T12:00:00.000Z');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-passkeys-'));
  deps = makeDeps();
  await writeRelayPin(PIN, home);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('POST /api/session-relay/passkeys/start', () => {
  it('writes an enrol statement for this computer, its account and its loopback port', async () => {
    const { res, bytes, statement, encoded } = await start();
    expect(statement).toMatchObject({
      t: 'dorkos.relay.passkey-enrol.v1',
      computerId: 'computer-1',
      computerName: 'Studio Mac',
      accountId: 'acct_owner',
      userHandle: approvalUserHandle('acct_owner', 'computer-1'),
      rpId: 'approve.dorkos.ai',
      origin: APPROVE,
      returnTo: `http://127.0.0.1:${port}/relay-passkey`,
      excludeCredentialIds: [],
      issuedAt: '2026-10-19T12:00:00.000Z',
      expiresAt: '2026-10-19T12:02:00.000Z',
    });
    expect(decodeStepUpBase64url(statement.nonce)).toHaveLength(32);
    expect(res.body.challenge).toBe(await stepUpChallenge(bytes));
    expect(res.body.approveUrl).toBe(`${APPROVE}/enrol#${encoded}`);
    // Never the sign-in passkey's user: the handle is per account and computer.
    expect(statement.userHandle).not.toBe(approvalUserHandle('acct_owner', 'computer-2'));
  });

  it('refuses without the owner’s password, and opens nothing', async () => {
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ label: 'MacBook passkey' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_RELAY_PASSWORD');
    expect(deps.passkeys.enrolment.open).toBe(false);
  });

  it.each<[string, { user?: RequestUser; ingress?: IngressKind }]>([
    ['Wi-Fi', { user: OWNER_COOKIE, ingress: 'wifi' }],
    // A passkey strengthens a sign-in, so it is added only at this computer,
    // even from an encrypted connection (DOR-3172).
    ['a tunnel', { user: OWNER_COOKIE, ingress: 'own-tunnel' }],
    ['managed remote access', { user: OWNER_COOKIE, ingress: 'managed' }],
    ['the relay', { user: OWNER_COOKIE, ingress: 'relay' }],
  ])('refuses from %s, password or not', async (_, caller) => {
    const res = await request(app(caller))
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(res.status).toBe(403);
    expect(deps.passkeys.enrolment.open).toBe(false);
  });

  it('refuses an agent at this computer', async () => {
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .set('x-dorkos-agent', 'agent-token')
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(res.status).toBe(403);
  });

  it('refuses when this computer is not linked, or its hub named no account', async () => {
    fs.rmSync(path.join(home, 'session-relay', 'pin.json'));
    const unlinked = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(unlinked.status).toBe(409);
    expect(unlinked.body.error).toBe('Link this computer to your hub first.');
    const { accountId: _account, ...noAccount } = PIN;
    await writeRelayPin(noAccount, home);
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(res.status).toBe(409);
  });

  it('lets a self-hoster pin their own approve page, and refuses one that is not https', async () => {
    const { statement } = await start({ origin: 'https://hub.example.test' });
    expect(statement).toMatchObject({
      rpId: 'hub.example.test',
      origin: 'https://hub.example.test',
    });
    for (const body of [
      { origin: 'http://hub.example.test' },
      { origin: 'https://hub.example.test/enrol' },
      { origin: 'https://hub.example.test', rpId: 'example.test' },
    ]) {
      const res = await request(app())
        .post('/api/session-relay/passkeys/start')
        .send({ password: PASSWORD, label: 'MacBook passkey', ...body });
      expect(res.status).toBe(400);
    }
  });

  it('keeps every later passkey on the approve page the first one pinned', async () => {
    const first = await start();
    expect(
      (
        await finish(
          first.encoded,
          authenticatorFor(first.statement).attest({ challenge: first.res.body.challenge })
        )
      ).status
    ).toBe(200);
    const other = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'Other', origin: 'https://hub.example.test' });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('Your passkeys use another approve page. Remove them to switch.');
    const second = await start();
    expect(second.statement.origin).toBe(APPROVE);
    expect(second.statement.excludeCredentialIds).toHaveLength(1);
  });

  it('replaces the live statement when started again', async () => {
    const first = await start();
    const second = await start();
    const passkey = authenticatorFor(first.statement);
    const stale = await finish(
      first.encoded,
      passkey.attest({ challenge: first.res.body.challenge })
    );
    expect(stale.status).toBe(400);
    expect(readApprovalKeys(home)).toBeNull();
    // That attempt used up the second statement too: each is tried once.
    const late = await finish(
      second.encoded,
      passkey.attest({ challenge: second.res.body.challenge })
    );
    expect(late.status).toBe(409);
  });
});

describe('POST /api/session-relay/passkeys/finish', () => {
  it.each(['ES256', 'Ed25519'] as const)(
    'pins a %s passkey under the statement’s relying party',
    async (alg) => {
      const { encoded, statement, res: started } = await start();
      const passkey = authenticatorFor(statement, alg);
      const res = await finish(encoded, passkey.attest({ challenge: started.body.challenge }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        rpId: 'approve.dorkos.ai',
        origin: APPROVE,
        keys: [
          {
            credentialId: passkey.credentialId,
            label: 'MacBook passkey',
            addedAt: '2026-10-19T12:00:00.000Z',
            alg: passkey.coseAlg,
          },
        ],
      });
      const pinned = readApprovalKeys(home)!;
      expect(pinned.userHandle).toBe(statement.userHandle);
      expect(pinned.keys[0]).toMatchObject({
        credentialId: passkey.credentialId,
        cosePublicKey: passkey.cosePublicKeyBase64url(),
        alg: passkey.coseAlg,
      });
      const added = vi
        .mocked(recordAudit)
        .mock.calls.find(([input]) => input.action === 'relay.passkey.added');
      expect(added?.[0].source).toEqual({ surface: 'app' });
      expect(JSON.stringify(added)).not.toContain(passkey.cosePublicKeyBase64url());
    }
  );

  it('refuses a finish with no live /start', async () => {
    const statement: PasskeyEnrolStatementV1 = {
      t: 'dorkos.relay.passkey-enrol.v1',
      challengeId: 'forged',
      computerId: 'computer-1',
      computerName: 'Studio Mac',
      accountId: 'acct_owner',
      userHandle: approvalUserHandle('acct_owner', 'computer-1'),
      nonce: randomBytes(32).toString('base64url'),
      issuedAt: '2026-10-19T12:00:00.000Z',
      expiresAt: '2026-10-19T12:02:00.000Z',
      rpId: 'approve.dorkos.ai',
      origin: APPROVE,
      returnTo: `http://127.0.0.1:${port || 4000}/relay-passkey`,
      excludeCredentialIds: [],
    };
    const { encodeStepUpStatement } = await import('@dork-labs/cloud-api');
    const bytes = encodeStepUpStatement(statement);
    const passkey = authenticatorFor(statement);
    const res = await finish(
      encodeStepUpBase64url(bytes),
      passkey.attest({ challenge: await stepUpChallenge(bytes) })
    );
    expect(res.status).toBe(409);
    expect(readApprovalKeys(home)).toBeNull();
    // Nothing was open, so nothing was refused: a stray post writes no audit row.
    expect(auditActions()).not.toContain('session-relay.passkey.add');
  });

  it('refuses a replayed statement', async () => {
    const { encoded, statement, res: started } = await start();
    const passkey = authenticatorFor(statement);
    const attestation = passkey.attest({ challenge: started.body.challenge });
    expect((await finish(encoded, attestation)).status).toBe(200);
    const again = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(again.status).toBe(409);
    expect(readApprovalKeys(home)!.keys).toHaveLength(1);
  });

  it('refuses a statement altered by one byte, even with a passkey made over it', async () => {
    const { statement, bytes } = await start();
    const altered = new Uint8Array(bytes);
    const at = new TextDecoder().decode(bytes).indexOf(statement.nonce);
    altered[at] = altered[at] === 0x41 ? 0x42 : 0x41;
    const passkey = authenticatorFor(statement);
    const res = await finish(
      encodeStepUpBase64url(altered),
      passkey.attest({ challenge: await stepUpChallenge(altered) })
    );
    expect(res.status).toBe(400);
    expect(lastRefusal()).toBe('not-this-statement');
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('refuses an expired statement', async () => {
    const { encoded, statement, res: started } = await start();
    clock = new Date('2026-10-19T12:02:00.000Z');
    const res = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(res.status).toBe(410);
    expect(lastRefusal()).toBe('expired');
    expect(readApprovalKeys(home)).toBeNull();
  });

  it.each<[string, { origin?: string; rpId?: string }]>([
    ['another dorkos.ai subdomain', { origin: 'https://cloud.dorkos.ai' }],
    ['the dorkos.ai apex', { origin: 'https://dorkos.ai' }],
    ['another relying party', { rpId: 'dorkos.ai' }],
  ])('refuses a passkey made from %s', async (_, where) => {
    const { encoded, statement, res: started } = await start();
    const passkey = authenticatorFor(statement);
    const res = await finish(
      encoded,
      passkey.attest({ challenge: started.body.challenge, ...where })
    );
    expect(res.status).toBe(400);
    expect(lastRefusal()).toBe('not-verified');
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('refuses a passkey without user verification, or made in a frame', async () => {
    for (const broken of [{ userVerified: false }, { crossOrigin: true }]) {
      const { encoded, statement, res: started } = await start();
      const passkey = authenticatorFor(statement);
      const res = await finish(
        encoded,
        passkey.attest({ challenge: started.body.challenge, ...broken })
      );
      expect(res.status).toBe(400);
      expect(lastRefusal()).toBe('not-verified');
    }
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('refuses a key that names an algorithm outside ES256, EdDSA and RS256', async () => {
    const { encoded, statement, res: started } = await start();
    const passkey = authenticatorFor(statement);
    const res = await finish(
      encoded,
      passkey.attest({ challenge: started.body.challenge, claimedAlg: -65535 })
    );
    expect(res.status).toBe(400);
    // The library refuses it first; the store would refuse it again.
    expect(['not-verified', 'algorithm']).toContain(lastRefusal());
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('refuses a passkey already pinned', async () => {
    const first = await start();
    const passkey = authenticatorFor(first.statement);
    expect(
      (await finish(first.encoded, passkey.attest({ challenge: first.res.body.challenge }))).status
    ).toBe(200);
    const second = await start();
    const res = await finish(
      second.encoded,
      passkey.attest({ challenge: second.res.body.challenge })
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('That passkey is already added.');
  });

  it('refuses to add over a damaged keys file, and leaves it exactly as it was', async () => {
    const { encoded, statement, res: started } = await start();
    fs.mkdirSync(path.dirname(approvalKeysPath(home)), { recursive: true });
    fs.writeFileSync(approvalKeysPath(home), '{"v":1,');
    const res = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/damaged/);
    expect(lastRefusal()).toBe('store');
    expect(fs.readFileSync(approvalKeysPath(home), 'utf8')).toBe('{"v":1,');
    const again = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(again.status).toBe(409);
  });

  it('uses up the statement on a body it cannot read', async () => {
    const { encoded, statement, res: started } = await start();
    const junk = await request(app())
      .post('/api/session-relay/passkeys/finish')
      .set('Origin', pageOrigin())
      .send({ statement: encoded, attestation: { nope: true } });
    expect(junk.status).toBe(400);
    const res = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(res.status).toBe(409);
  });

  it('refuses from anywhere but this computer', async () => {
    const { encoded, statement, res: started } = await start();
    const res = await request(app({ user: OWNER_COOKIE, ingress: 'own-tunnel' }))
      .post('/api/session-relay/passkeys/finish')
      .send({
        statement: encoded,
        attestation: registration(
          authenticatorFor(statement).attest({ challenge: started.body.challenge })
        ),
      });
    expect(res.status).toBe(403);
    expect(deps.passkeys.enrolment.open).toBe(true);
  });
});

describe('listing and removing passkeys', () => {
  async function pinOne() {
    const { encoded, statement, res: started } = await start();
    const passkey = authenticatorFor(statement);
    await finish(encoded, passkey.attest({ challenge: started.body.challenge }));
    vi.mocked(recordAudit).mockClear();
    return passkey;
  }

  it('lists labels and dates at this computer, never key material', async () => {
    const passkey = await pinOne();
    const res = await request(app()).get('/api/session-relay/passkeys');
    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([
      expect.objectContaining({ credentialId: passkey.credentialId, label: 'MacBook passkey' }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(passkey.cosePublicKeyBase64url());
    expect(res.body.keys[0]).not.toHaveProperty('cosePublicKey');
    expect(res.body.keys[0]).not.toHaveProperty('signCount');
  });

  it('lists nothing to another device or an agent', async () => {
    await pinOne();
    const remote = await request(app({ user: OWNER_COOKIE, ingress: 'own-tunnel' })).get(
      '/api/session-relay/passkeys'
    );
    expect(remote.status).toBe(403);
    const agent = await request(app())
      .get('/api/session-relay/passkeys')
      .set('x-dorkos-agent', 'agent-token');
    expect(agent.status).toBe(403);
  });

  it('removes one with the owner’s password, and audits it', async () => {
    const passkey = await pinOne();
    const id = encodeURIComponent(passkey.credentialId);
    const without = await request(app()).delete(`/api/session-relay/passkeys/${id}`);
    expect(without.status).toBe(403);
    expect(readApprovalKeys(home)!.keys).toHaveLength(1);
    const remote = await request(app({ user: OWNER_COOKIE, ingress: 'own-tunnel' }))
      .delete(`/api/session-relay/passkeys/${id}`)
      .send({ password: PASSWORD });
    expect(remote.status).toBe(403);
    const res = await request(app())
      .delete(`/api/session-relay/passkeys/${id}`)
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rpId: null, origin: null, keys: [] });
    expect(readApprovalKeys(home)).toBeNull();
    const removed = vi
      .mocked(recordAudit)
      .mock.calls.find(([input]) => input.action === 'relay.passkey.removed');
    expect(removed?.[0].source).toEqual({ surface: 'app' });
    const missing = await request(app())
      .delete(`/api/session-relay/passkeys/${id}`)
      .send({ password: PASSWORD });
    expect(missing.status).toBe(404);
  });
});

describe('finishing with no session, while this computer asks for a password', () => {
  /** A started enrolment and a passkey made over it, with the password then turned on. */
  async function ready() {
    const started = await start();
    const attestation = authenticatorFor(started.statement).attest({
      challenge: started.res.body.challenge,
    });
    state.login = true;
    return {
      encoded: started.encoded,
      body: { statement: started.encoded, attestation: registration(attestation) },
    };
  }

  it('pins the passkey from the return page: loopback, its own Origin, the live statement', async () => {
    const { body } = await ready();
    const res = await request(app())
      .post('/api/session-relay/passkeys/finish')
      .set('Origin', pageOrigin())
      .send(body);
    expect(res.status).toBe(200);
    expect(readApprovalKeys(home)?.keys).toHaveLength(1);
  });

  it('refuses a request carrying a proxy forwarding header, and keeps the statement', async () => {
    const { body } = await ready();
    const res = await request(app())
      .post('/api/session-relay/passkeys/finish')
      .set('Origin', pageOrigin())
      .set('X-Forwarded-For', '203.0.113.9')
      .send(body);
    expect(res.status).toBe(403);
    expect(readApprovalKeys(home)).toBeNull();
    expect(deps.passkeys.enrolment.open).toBe(true);
  });

  it('refuses a socket that is not loopback', async () => {
    const { body } = await ready();
    state.remotePeer = true;
    const res = await request(app())
      .post('/api/session-relay/passkeys/finish')
      .set('Origin', pageOrigin())
      .send(body);
    expect(res.status).toBe(403);
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('refuses a request with no Origin, and uses the statement up', async () => {
    const { body } = await ready();
    const res = await request(app()).post('/api/session-relay/passkeys/finish').send(body);
    expect(res.status).toBe(403);
    expect(readApprovalKeys(home)).toBeNull();
    expect(deps.passkeys.enrolment.open).toBe(false);
    expect(lastRefusal()).toBe('origin');
  });

  it.each([
    ['another loopback name', 'http://localhost:PORT'],
    ['another port', 'http://127.0.0.1:1'],
  ])('refuses an Origin on %s', async (_, origin) => {
    const { body } = await ready();
    const res = await request(app())
      .post('/api/session-relay/passkeys/finish')
      .set('Origin', origin.replace('PORT', String(port)))
      .send(body);
    // The chain's CORS check refuses a cross-origin write before the route:
    // nothing is pinned, and the statement stays for the return page itself.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(readApprovalKeys(home)).toBeNull();
    expect(deps.passkeys.enrolment.open).toBe(true);
  });

  it('refuses a body that is not JSON', async () => {
    const { body } = await ready();
    const res = await request(app())
      .post('/api/session-relay/passkeys/finish')
      .set('Origin', pageOrigin())
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(body));
    expect(res.status).toBe(403);
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('keeps every other passkey route behind the login gate', async () => {
    state.login = true;
    const started = await request(app())
      .post('/api/session-relay/passkeys/start')
      .set('Origin', pageOrigin())
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(started.status).toBe(401);
    const removed = await request(app())
      .delete('/api/session-relay/passkeys/cred-1')
      .send({ password: PASSWORD });
    expect(removed.status).toBe(401);
    expect((await request(app()).get('/api/session-relay/passkeys')).status).toBe(401);
    expect(deps.passkeys.enrolment.open).toBe(false);
  });
});

describe('GET /relay-passkey', () => {
  it('serves a static page at this computer, under a CSP with no inline script', async () => {
    const res = await request(app()).get('/relay-passkey');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(RELAY_PASSKEY_CSP);
    expect(RELAY_PASSKEY_CSP).toContain("default-src 'none'");
    expect(RELAY_PASSKEY_CSP).toContain("script-src 'self'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const html = res.text;
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toContain('src="/relay-passkey.js"');
    expect(scripts[0]![2]).toBe('');
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('serves its own script, which posts to finish and clears the fragment', async () => {
    const res = await request(app()).get('/relay-passkey.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/javascript/);
    expect(res.text).toContain('/api/session-relay/passkeys/finish');
    expect(res.text).toContain('history.replaceState');
    expect(res.text).not.toMatch(/https?:\/\//);
  });

  it.each<[string, IngressKind]>([
    ['Wi-Fi', 'wifi'],
    ['a tunnel', 'own-tunnel'],
  ])('is refused from %s', async (_, ingress) => {
    for (const pathname of ['/relay-passkey', '/relay-passkey.js']) {
      const res = await request(app({ user: OWNER_COOKIE, ingress })).get(pathname);
      expect(res.status).toBe(403);
      expect(res.text).not.toContain('passkeys/finish');
    }
  });

  it('is not there while the experiment is off', async () => {
    state.relay = false;
    expect((await request(app()).get('/relay-passkey')).status).toBe(404);
  });
});

describe('the link the statement was written for', () => {
  it('refuses a finish after Unlink, and pins nothing', async () => {
    const { encoded, statement, res: started } = await start();
    clearRelayPin(home);
    const res = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(res.status).toBe(409);
    expect(lastRefusal()).toBe('unlinked');
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('refuses a finish after linking to another account', async () => {
    const { encoded, statement, res: started } = await start();
    await writeRelayPin({ ...PIN, accountId: 'acct_other' }, home);
    const res = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(res.status).toBe(409);
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('removes passkeys made for another account when the computer links again, and audits it', async () => {
    const { encoded, statement, res: started } = await start();
    await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(readApprovalKeys(home)?.keys).toHaveLength(1);
    // Pausing rewrites the same pin: the passkeys stay.
    await writeRelayPin({ ...PIN, paused: true }, home);
    expect(readApprovalKeys(home)?.keys).toHaveLength(1);
    await writeRelayPin({ ...PIN, accountId: 'acct_other' }, home);
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
    expect(auditActions()).toContain('relay.passkey.removed-stale');
  });

  it('drops the live enrolment when the pin is cleared or a new link is saved', async () => {
    const live = passkeyEnrolment();
    const begin = () =>
      live.start({
        computerId: 'computer-1',
        computerName: 'Studio Mac',
        accountId: 'acct_owner',
        label: 'MacBook passkey',
        pinned: null,
        hubOrigin: PIN.hubOrigin,
        issuer: PIN.issuer,
        localAddress: '127.0.0.1',
        port: 4000,
      });
    await begin();
    expect(live.open).toBe(true);
    clearRelayPin(home);
    expect(live.open).toBe(false);
    await begin();
    await writeRelayPin({ ...PIN, computerId: 'computer-2' }, home);
    expect(live.open).toBe(false);
  });

  it('lets one of two finishes at once through, never both', async () => {
    const { encoded, statement, res: started } = await start();
    const attestation = authenticatorFor(statement).attest({ challenge: started.body.challenge });
    const [a, b] = await Promise.all([finish(encoded, attestation), finish(encoded, attestation)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(readApprovalKeys(home)?.keys).toHaveLength(1);
  });
});

describe('approve pages a start may not name', () => {
  it('refuses the hub itself as the approve page', async () => {
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey', origin: PIN.hubOrigin });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The approve page can’t be your hub itself.');
  });

  it('refuses any other approve page for a DorkOS Cloud account', async () => {
    await writeRelayPin({ ...PIN, issuer: 'https://cloud.dorkos.ai' }, home);
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey', origin: 'https://hub.example.test' });
    expect(res.status).toBe(400);
    const { statement } = await start();
    expect(statement.origin).toBe(APPROVE);
  });

  it('says the hub names no account, for a self-hosted link without one', async () => {
    const { accountId: _account, ...noAccount } = PIN;
    await writeRelayPin(noAccount, home);
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This hub doesn’t name an account yet.');
  });
});

describe('a damaged passkeys file', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(approvalKeysPath(home)), { recursive: true });
    fs.writeFileSync(approvalKeysPath(home), '{"v":1,');
  });

  it('is reported by the list', async () => {
    const res = await request(app()).get('/api/session-relay/passkeys');
    expect(res.body).toEqual({ damaged: true, rpId: null, origin: null, keys: [] });
  });

  it('is removed at this computer with the password, and audited; a sound file never is', async () => {
    const without = await request(app()).delete('/api/session-relay/passkeys');
    expect(without.status).toBe(403);
    expect(fs.existsSync(approvalKeysPath(home))).toBe(true);
    const remote = await request(app({ user: OWNER_COOKIE, ingress: 'own-tunnel' }))
      .delete('/api/session-relay/passkeys')
      .send({ password: PASSWORD });
    expect(remote.status).toBe(403);
    const res = await request(app())
      .delete('/api/session-relay/passkeys')
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rpId: null, origin: null, keys: [] });
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
    expect(auditActions()).toContain('relay.passkey.removed-damaged');
    const again = await start();
    await finish(
      again.encoded,
      authenticatorFor(again.statement).attest({ challenge: again.res.body.challenge })
    );
    const whole = await request(app())
      .delete('/api/session-relay/passkeys')
      .send({ password: PASSWORD });
    expect(whole.status).toBe(409);
    expect(readApprovalKeys(home)?.keys).toHaveLength(1);
  });
});

describe('a server listening on ::1, as a default install on macOS does', () => {
  /** One request over IPv6 loopback, under the `Host` a browser at that address sends. */
  function send(
    server: http.Server,
    request: { method: 'GET' | 'POST'; pathname: string; host: string; body?: unknown },
    headers: Record<string, string> = {}
  ): Promise<{ status: number; text: string }> {
    const { port: p } = server.address() as AddressInfo;
    const data = request.body === undefined ? undefined : JSON.stringify(request.body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '::1',
          port: p,
          method: request.method,
          path: request.pathname,
          headers: {
            Host: `${request.host}:${p}`,
            ...(data === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  it('names [::1] in returnTo, serves the page there, and the passkey finishes from it', async () => {
    const server = http.createServer(
      honoGroupListener([
        { path: '/api/session-relay', routes: createSessionRelayRoutes(deps) },
        { path: '/', routes: createRelayPasskeyPageRoutes() },
      ])
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', () => resolve());
    });
    try {
      const { port: p } = server.address() as AddressInfo;
      // The owner's browser is on `localhost`, which on macOS reaches `::1`.
      const started = await send(server, {
        method: 'POST',
        pathname: '/api/session-relay/passkeys/start',
        host: 'localhost',
        body: { password: PASSWORD, label: 'MacBook passkey' },
      });
      expect(started.status).toBe(200);
      const body = JSON.parse(started.text) as { statement: string; challenge: string };
      const statement = decodeStepUpStatement(
        decodeStepUpBase64url(body.statement)
      ) as PasskeyEnrolStatementV1;
      // The IP literal, never the name `localhost` (RFC 8252 §8.3).
      expect(statement.returnTo).toBe(`http://[::1]:${p}/relay-passkey`);

      // The approve page sends the browser to `returnTo`: the page answers a `[::1]` Host.
      for (const pathname of ['/relay-passkey', '/relay-passkey.js']) {
        const page = await send(server, { method: 'GET', pathname, host: '[::1]' });
        expect(page.status, pathname).toBe(200);
      }

      // Its script posts from `http://[::1]:<port>`: the classifier calls it this computer.
      const attestation = authenticatorFor(statement).attest({ challenge: body.challenge });
      const res = await send(
        server,
        {
          method: 'POST',
          pathname: '/api/session-relay/passkeys/finish',
          host: '[::1]',
          body: { statement: body.statement, attestation: registration(attestation) },
        },
        { Origin: `http://[::1]:${p}` }
      );
      expect(res.status).toBe(200);
      expect(readApprovalKeys(home)?.keys).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('an Unlink while a passkey is being written', () => {
  it('refuses the key when the pin goes during the checks, and a relink finds no keys', async () => {
    const real = deps.passkeys.addKey;
    deps.passkeys.addKey = async (party, key, audit, stillLinked) => {
      // The owner unlinks after the checks passed, before the key is written.
      clearRelayPin(home);
      return real(party, key, audit, stillLinked);
    };
    const { encoded, statement, res: started } = await start();
    const res = await finish(
      encoded,
      authenticatorFor(statement).attest({ challenge: started.body.challenge })
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This computer’s link changed. Start again in Settings.');
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
    await writeRelayPin(PIN, home);
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
  });

  it('removes a key written as the pin goes, once the write it raced has finished', async () => {
    const pinned = authenticatorFor((await start()).statement);
    // Queued on the keys file's lock, with no link check, as a write already under way.
    const writing = addApprovalKey(
      { rpId: 'approve.dorkos.ai', origin: APPROVE, userHandle: pinned.userHandle },
      {
        credentialId: pinned.credentialId,
        cosePublicKey: pinned.cosePublicKeyBase64url(),
        alg: -7,
        signCount: 0,
        label: 'MacBook passkey',
        addedAt: '2026-10-19T12:00:00.000Z',
      },
      deps.passkeys.audit,
      home
    );
    clearRelayPin(home);
    await writing;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
  });

  it('removes a keys file found when a computer with no pin links, and audits it', async () => {
    clearRelayPin(home);
    const pinned = new SoftAuthenticator({
      rpId: 'approve.dorkos.ai',
      origin: APPROVE,
      userHandle: approvalUserHandle('acct_owner', 'computer-1'),
    });
    await addApprovalKey(
      { rpId: 'approve.dorkos.ai', origin: APPROVE, userHandle: pinned.userHandle },
      {
        credentialId: pinned.credentialId,
        cosePublicKey: pinned.cosePublicKeyBase64url(),
        alg: -7,
        signCount: 0,
        label: 'MacBook passkey',
        addedAt: '2026-10-19T12:00:00.000Z',
      },
      deps.passkeys.audit,
      home
    );
    expect(fs.existsSync(approvalKeysPath(home))).toBe(true);
    await writeRelayPin(PIN, home);
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
    expect(auditActions()).toContain('relay.passkey.removed-stale');
  });
});

describe('a passkeys file that cannot be read just now', () => {
  it('is not damaged: the list says nothing of it, and Remove refuses rather than deleting', async () => {
    fs.mkdirSync(path.dirname(approvalKeysPath(home)), { recursive: true });
    fs.writeFileSync(approvalKeysPath(home), '{"v":1,');
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (file === approvalKeysPath(home)) {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      }
      return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      const list = await request(app()).get('/api/session-relay/passkeys');
      expect(list.body).toEqual({ rpId: null, origin: null, keys: [] });
      const res = await request(app())
        .delete('/api/session-relay/passkeys')
        .send({ password: PASSWORD });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Couldn’t read the passkeys file here. Try again.');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(approvalKeysPath(home), 'utf8')).toBe('{"v":1,');
  });
});

describe('an issuer written as a fully qualified host', () => {
  it('is still DorkOS Cloud: any other approve page is refused', async () => {
    await writeRelayPin({ ...PIN, issuer: 'https://cloud.dorkos.ai.' }, home);
    const res = await request(app())
      .post('/api/session-relay/passkeys/start')
      .send({ password: PASSWORD, label: 'MacBook passkey', origin: 'https://hub.example.test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A DorkOS account uses the DorkOS approve page. Leave it unset.');
  });
});
