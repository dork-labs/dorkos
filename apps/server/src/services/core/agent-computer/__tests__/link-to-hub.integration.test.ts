/**
 * @vitest-environment node
 *
 * A cloud agent computer links to an in-process hub, end to end (DOR-2940):
 * the hub mints a code bound to the computer and hands it to a fake Cloud, the
 * computer reads its assignment with that code, redeems it at the hub's real
 * `POST /api/hub/link` behind the real `/api` chain, checks the hub's signed
 * answer and pins the hub. Then the second-redeem rule: someone inside Cloud
 * redeems first, the real computer's redeem is the security event, and the new
 * code the hub mints links the real computer. And every route-level refusal
 * an agent computer's redeem can meet.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { RelayLinkRequest } from '@dorkos/shared/session-relay-link';

vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => 'hub' }));
vi.mock('../../hub/hub-serving.js', () => ({
  admitHubRequest: () => null,
  trackHubConnection: () => {},
  hubServingState: () => ({ state: 'starting' }),
}));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../../audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../audit/audit-trail.js')>()),
  recordAudit: audit.record,
}));

import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { createHubLinkRoutes, hubLinkBodyRule } from '../../../../routes/hub-link.js';
import {
  AgentComputerCodeBook,
  LinkCodeBook,
  forgetLinkedComputer,
  linkComputer,
  mintAgentComputerLinkCode,
  readLinkedComputers,
  redeemAgentComputerCode,
  relaySecretHash,
  type AgentComputerLinkDeps,
  type HubLinkSigner,
} from '../../hub-relay/index.js';
import { pinnableKey } from '../../session-relay/channel.js';
import { signRelayLinkRequest } from '../../session-relay/link-signature.js';
import { computerPublicKey, readRelayPin, writeRelayPin } from '../../session-relay/pin-store.js';
import { redeemAtHub } from '../../session-relay/relay-link.js';
import { AgentComputerAssignmentSync } from '../assignment-sync.js';
import {
  fakeAgentComputerCloud,
  type FakeAgentComputerCloud,
} from './fake-agent-computer-cloud.js';

const HUB_ORIGIN = 'https://hub.example.invalid';
const OWNER = { ownerAccountId: 'acct_owner', issuer: 'https://id.dorkos.ai' };
const CLOUD_ID = 'cmp_01';
const RELAY_ID = `ac:${CLOUD_ID}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-ac-link-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const hubKey = generateKeyPairSync('ed25519').privateKey;
const hubSigner: HubLinkSigner = {
  sign: (data) => sign(null, data, hubKey),
  publicKey: pinnableKey(hubKey),
};
const clock = { now: Date.now() };

let hubHome: string;
let computerHome: string;
let cloud: FakeAgentComputerCloud;
let hubDeps: AgentComputerLinkDeps;

const routeDeps = {
  isHub: () => true,
  servingOrigin: () => HUB_ORIGIN,
  signer: () => hubSigner,
  owner: () => OWNER,
  consume: (code: string) => new LinkCodeBook().consume(code),
  link: vi.fn(async () => ({})),
  redeemAgentComputer: (req: RelayLinkRequest, cloudComputerId: string) =>
    redeemAgentComputerCode(req, cloudComputerId, hubDeps),
};

const server = listeningServer(
  honoGroupListener(
    { path: '/api/hub/link', routes: createHubLinkRoutes(routeDeps) },
    { bodyRules: [hubLinkBodyRule] }
  )
);

/** The computer's `fetch`, aimed at the in-process hub instead of the network. */
const toHub: typeof fetch = async (input, init) => {
  const { port } = server.address() as AddressInfo;
  const url = new URL(String(input));
  return fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
};

/** The computer's side, with a dialer that only counts. */
function computer(home = computerHome) {
  const dialer = { dialNow: vi.fn(() => 'applied' as const), close: vi.fn() };
  const sync = new AgentComputerAssignmentSync({
    readAssignment: () => cloud.readAssignment(),
    readPin: () => readRelayPin(home),
    writePin: (pin) => writeRelayPin(pin, home),
    redeem: (input) =>
      redeemAtHub(input, {
        dorkHome: home,
        fetch: toHub,
        lookup: async () => [{ address: '203.0.113.7' }],
      }),
    dialer,
  });
  return { sync, dialer };
}

beforeEach(() => {
  vi.clearAllMocks();
  hubHome = fs.mkdtempSync(path.join(tmp, 'hub-'));
  computerHome = fs.mkdtempSync(path.join(tmp, 'computer-'));
  cloud = fakeAgentComputerCloud({ computerId: CLOUD_ID, hubOrigin: HUB_ORIGIN, ...OWNER });
  hubDeps = {
    codes: new AgentComputerCodeBook(
      () => hubHome,
      () => clock.now
    ),
    handToCloud: (id, body) => cloud.handToCloud(id, body),
    readLinked: () => readLinkedComputers(hubHome),
    link: (input) => linkComputer(input, hubHome),
    unlink: (id) => forgetLinkedComputer(id, hubHome),
  };
});
afterEach(() => {
  clock.now = Date.now();
});

describe('linking end to end', () => {
  it('links the computer with the code its hub minted, and pins the hub', async () => {
    const { sync, dialer } = computer();
    // Before the hub mints, the computer waits.
    expect(await sync.sync()).toMatchObject({ kind: 'waiting' });

    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    expect(cloud.handed).toBe(1);
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    expect(dialer.dialNow).toHaveBeenCalled();

    // The computer pinned the hub's own key, its origin and its owner.
    const pin = readRelayPin(computerHome)!;
    expect(pin).toMatchObject({
      computerId: RELAY_ID,
      hubOrigin: HUB_ORIGIN,
      hubKey: hubSigner.publicKey,
      accountId: OWNER.ownerAccountId,
      issuer: OWNER.issuer,
    });
    // The hub pinned the computer's own key, under its cloud id, and the hash
    // of the secret the computer kept.
    expect(readLinkedComputers(hubHome)).toEqual([
      expect.objectContaining({
        v: 2,
        role: 'agent-computer',
        cloudComputerId: CLOUD_ID,
        computerId: RELAY_ID,
        computerKey: computerPublicKey(computerHome),
        secretHash: relaySecretHash(pin.relaySecret),
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub.relay.computer.link', outcome: 'ok' })
    );
  });

  it('survives the hub sleeping between minting and the redeem', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    // A woken hub has a new book in memory over the same folder.
    hubDeps.codes = new AgentComputerCodeBook(
      () => hubHome,
      () => clock.now
    );
    const { sync } = computer();
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
  });

  it('treats a second redeem as a security event, then links the real computer', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    // Someone inside Cloud reads the code first and redeems it with their own key.
    const stolen = cloud.peekCode()!;
    const intruderHome = fs.mkdtempSync(path.join(tmp, 'intruder-'));
    const intruder = await redeemAtHub(
      {
        origin: HUB_ORIGIN,
        code: stolen.code,
        computerId: RELAY_ID,
        computerName: 'Cloud computer',
      },
      { dorkHome: intruderHome, fetch: toHub, lookup: async () => [{ address: '203.0.113.7' }] }
    );
    expect(intruder.ok).toBe(true);
    expect(readLinkedComputers(hubHome)[0]?.computerKey).toBe(computerPublicKey(intruderHome));

    // The real computer redeems the same code: the hub trusts neither.
    const { sync } = computer();
    expect(await sync.sync()).toEqual({ kind: 'failed' });
    expect(readLinkedComputers(hubHome)).toEqual([]);
    expect(readRelayPin(computerHome)).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub.relay.agent-computer.second-redeem',
        outcome: 'refused',
        error: 'code_redeemed_twice',
        target: expect.objectContaining({ id: RELAY_ID }),
      })
    );
    // And a fresh code is on its way, which links the real computer.
    expect(cloud.handed).toBe(2);
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    expect(readLinkedComputers(hubHome)[0]?.computerKey).toBe(computerPublicKey(computerHome));
    // The intruder's secret no longer opens anything.
    expect(readLinkedComputers(hubHome)).toHaveLength(1);
  });

  it('links the same computer again with a new code, keeping its key', async () => {
    const { sync, dialer } = computer();
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    await sync.sync();
    const first = readRelayPin(computerHome)!;
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    const second = readRelayPin(computerHome)!;
    expect(second.hubKey).toBe(first.hubKey);
    expect(second.relaySecret).not.toBe(first.relaySecret);
    // The old connection was proved with the old secret.
    expect(dialer.close).toHaveBeenCalled();
    expect(readLinkedComputers(hubHome)[0]?.secretHash).toBe(relaySecretHash(second.relaySecret));
  });

  it('refuses a hub that answers a relink with a different key, and stops', async () => {
    const { sync, dialer } = computer();
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    await sync.sync();
    // A different hub key at the pinned origin.
    const other = generateKeyPairSync('ed25519').privateKey;
    const original = { ...hubSigner };
    hubSigner.sign = (data) => sign(null, data, other);
    hubSigner.publicKey = pinnableKey(other);
    try {
      await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
      expect(await sync.sync()).toEqual({ kind: 'refused', reason: 'different-hub-key' });
      expect(dialer.close).toHaveBeenCalled();
      expect(readRelayPin(computerHome)?.hubKey).toBe(original.publicKey);
      // Stopped for good: later reads do nothing.
      expect(await sync.sync()).toEqual({ kind: 'refused', reason: 'different-hub-key' });
    } finally {
      hubSigner.sign = original.sign;
      hubSigner.publicKey = original.publicKey;
    }
  });

  it('refuses a hub whose answer names another owner than the assignment', async () => {
    cloud.set({ ownerAccountId: 'acct_someone_else' });
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const { sync } = computer();
    expect(await sync.sync()).toEqual({ kind: 'refused', reason: 'hub-names-different-owner' });
    expect(readRelayPin(computerHome)).toBeNull();
  });
});

describe('the hub refuses an agent computer`s redeem', () => {
  const computerKey = () => generateKeyPairSync('ed25519').privateKey;

  function redeemBody(
    code: string,
    overrides: Partial<RelayLinkRequest> = {},
    key = computerKey()
  ) {
    return signRelayLinkRequest(
      {
        v: 1,
        code,
        computerId: RELAY_ID,
        secretHash: 'h'.repeat(43),
        computerName: 'Cloud computer',
        ...overrides,
      },
      HUB_ORIGIN,
      key
    );
  }
  const post = (body: unknown) =>
    request(server)
      .post('/api/hub/link')
      .send(body as object);

  it('for another computer: a code is bound to the computer it was minted for', async () => {
    await mintAgentComputerLinkCode('cmp_other', {
      ...hubDeps,
      handToCloud: async () => undefined,
    });
    // The code went nowhere this test can see; mint one for ours and try it as another.
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const code = cloud.peekCode()!.code;
    const res = await post(redeemBody(code, { computerId: 'ac:cmp_other' }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LINK_REFUSED');
    expect((await post(redeemBody(code))).status).toBe(200);
  });

  it('once it has expired', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const code = cloud.peekCode()!.code;
    clock.now += 10 * 60 * 1000;
    expect((await post(redeemBody(code))).status).toBe(401);
  });

  it('once a newer code replaced it', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const old = cloud.peekCode()!.code;
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    expect((await post(redeemBody(old))).status).toBe(401);
    expect((await post(redeemBody(cloud.peekCode()!.code))).status).toBe(200);
  });

  it('with a bad signature, spending nothing', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const code = cloud.peekCode()!.code;
    const forged = { ...redeemBody(code), computerKey: pinnableKey(computerKey()) };
    expect((await post(forged)).status).toBe(401);
    expect(readLinkedComputers(hubHome)).toEqual([]);
    expect((await post(redeemBody(code))).status).toBe(200);
  });

  it('as a security event, for a fresh code naming a computer linked under another key', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    expect((await post(redeemBody(cloud.peekCode()!.code))).status).toBe(200);
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const res = await post(redeemBody(cloud.peekCode()!.code));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LINK_RESET');
    expect(readLinkedComputers(hubHome)).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'already_linked_other_key' })
    );
  });

  it('but answers a retry by the key that spent the code (a lost answer)', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const code = cloud.peekCode()!.code;
    const key = computerKey();
    expect((await post(redeemBody(code, {}, key))).status).toBe(200);
    const retry = redeemBody(code, { secretHash: 'r'.repeat(43) }, key);
    expect((await post(retry)).status).toBe(200);
    expect(readLinkedComputers(hubHome)[0]?.secretHash).toBe('r'.repeat(43));
  });

  it('a retry by the spending key after the computer was unlinked', async () => {
    await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    const code = cloud.peekCode()!.code;
    const key = computerKey();
    expect((await post(redeemBody(code, {}, key))).status).toBe(200);
    await forgetLinkedComputer(RELAY_ID, hubHome);
    expect((await post(redeemBody(code, {}, key))).status).toBe(401);
  });

  it('with a relay id that holds no cloud id the relay can carry', async () => {
    expect((await post(redeemBody('0000000000000000', { computerId: 'ac:a:b' }))).status).toBe(400);
  });

  it('with an owner`s code: the owner`s three codes never link an agent computer', async () => {
    const ownerBook = new LinkCodeBook();
    const { code } = ownerBook.mint();
    expect((await post(redeemBody(code))).status).toBe(401);
  });
});

describe('minting', () => {
  it('refuses a cloud id the relay cannot carry, minting nothing', async () => {
    await expect(mintAgentComputerLinkCode('has a space', hubDeps)).rejects.toThrow();
    expect(cloud.handed).toBe(0);
  });

  it('hands Cloud an expiry at most ten minutes out', async () => {
    const { expiresAt } = await mintAgentComputerLinkCode(CLOUD_ID, hubDeps);
    expect(Date.parse(cloud.peekCode()!.expiresAt)).toBe(expiresAt);
    expect(expiresAt - clock.now).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});
