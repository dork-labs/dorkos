/**
 * @vitest-environment node
 *
 * An agent computer's read of its assignment (DOR-2940), against a fake Cloud
 * and a stand-in hub: waiting for a code, linking, following a moved hub with
 * the pinned key, and every refusal that stops the computer working.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { RelayPin, RelayPinInput } from '../../session-relay/pin-store.js';
import type { RedeemAtHubInput, RedeemAtHubResult } from '../../session-relay/relay-link.js';
import { AgentComputerAssignmentSync } from '../assignment-sync.js';
import {
  fakeAgentComputerCloud,
  type FakeAgentComputerCloud,
} from './fake-agent-computer-cloud.js';

const HUB = 'https://hub.example.invalid';
const OWNER = { ownerAccountId: 'acct_owner', issuer: 'https://id.dorkos.ai' };
const HUB_KEY = 'K'.repeat(43);
const CODE = { code: '7K3MQ9TDX2HV8RNB', expiresAt: '2026-10-18T12:10:00.000Z' };

let cloud: FakeAgentComputerCloud;
let pin: RelayPin | null;
let answer: RedeemAtHubResult;
const redeem = vi.fn(async (_input: RedeemAtHubInput) => answer);
const proved: Array<() => void> = [];
const dialer = {
  dialNow: vi.fn(() => 'applied' as const),
  dialAt: vi.fn((_origin: string, onProved: () => void) => {
    proved.push(onProved);
    return 'applied' as const;
  }),
  close: vi.fn(),
};
const checkHost = vi.fn(async (_origin: string) => 'ok' as 'ok' | 'not-public' | 'hub-unreachable');
let clockNow = new Date('2026-10-18T12:00:00.000Z');
let sync: AgentComputerAssignmentSync;

beforeEach(() => {
  vi.clearAllMocks();
  proved.length = 0;
  clockNow = new Date('2026-10-18T12:00:00.000Z');
  checkHost.mockResolvedValue('ok');
  cloud = fakeAgentComputerCloud({ computerId: 'cmp_1', hubOrigin: HUB, ...OWNER });
  pin = null;
  answer = {
    ok: true,
    answer: { v: 1, hubKey: HUB_KEY, ...OWNER, signature: 's'.repeat(86) },
    relaySecret: 'r'.repeat(43),
  };
  sync = new AgentComputerAssignmentSync({
    readAssignment: () => cloud.readAssignment(),
    readPin: () => pin,
    writePin: async (next: RelayPinInput) => {
      pin = { level: 'chat', paused: false, ...next } as RelayPin;
    },
    redeem,
    checkHost,
    dialer,
    now: () => clockNow,
  });
});

/** Hand the computer a code, as a hub would through Cloud. */
const handCode = () => cloud.handToCloud('cmp_1', CODE);

describe('linking', () => {
  it('waits, dialing nothing, while no code has come', async () => {
    cloud.set({ pollAfterSeconds: 20 });
    expect(await sync.sync()).toEqual({ kind: 'waiting', pollAfterSeconds: 20 });
    expect(redeem).not.toHaveBeenCalled();
    expect(dialer.dialNow).not.toHaveBeenCalled();
  });

  it('redeems the code at the hub`s origin under its relay id, pins the hub, and dials', async () => {
    await handCode();
    expect(await sync.sync()).toEqual({ kind: 'linked', pollAfterSeconds: null });
    expect(redeem).toHaveBeenCalledWith({
      origin: HUB,
      code: CODE.code,
      computerId: 'ac:cmp_1',
      computerName: 'Cloud computer',
    });
    expect(pin).toMatchObject({
      v: 2,
      computerId: 'ac:cmp_1',
      hubOrigin: HUB,
      hubKey: HUB_KEY,
      relaySecret: 'r'.repeat(43),
      accountId: OWNER.ownerAccountId,
      issuer: OWNER.issuer,
    });
    expect(dialer.dialNow).toHaveBeenCalledTimes(1);
  });

  it('pins nothing when the hub refuses the code, and tries again later', async () => {
    await handCode();
    answer = { ok: false, reason: 'hub-refused' };
    expect(await sync.sync()).toEqual({ kind: 'failed' });
    expect(pin).toBeNull();
    expect(dialer.dialNow).not.toHaveBeenCalled();
  });

  it('keeps dialing the hub it pinned when the read fails', async () => {
    await handCode();
    await sync.sync();
    dialer.dialNow.mockClear();
    cloud.failNextRead();
    expect(await sync.sync()).toEqual({ kind: 'failed' });
    expect(dialer.dialNow).toHaveBeenCalledTimes(1);
  });

  it('treats an answer it cannot parse as a failed read', async () => {
    const odd = new AgentComputerAssignmentSync({
      readAssignment: async () => ({ computerId: 'cmp_1' }),
      readPin: () => null,
      writePin: async () => undefined,
      redeem,
      checkHost,
      dialer,
    });
    expect(await odd.sync()).toEqual({ kind: 'failed' });
  });
});

describe('a code kept until it links or expires', () => {
  it('tries the same code again after a failed redeem, though Cloud hands it out once', async () => {
    await handCode();
    answer = { ok: false, reason: 'hub-unreachable' };
    expect(await sync.sync()).toEqual({ kind: 'failed' });
    const good: RedeemAtHubResult = {
      ok: true,
      answer: { v: 1, hubKey: HUB_KEY, ...OWNER, signature: 's'.repeat(86) },
      relaySecret: 'r'.repeat(43),
    };
    answer = good;
    // Cloud's next read carries no code; the kept one is redeemed.
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    expect(redeem).toHaveBeenCalledTimes(2);
    expect(redeem.mock.calls[1]![0].code).toBe(CODE.code);
    expect(pin).not.toBeNull();
    // Linked: the code is spent and gone.
    await sync.sync();
    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it('stops trying a code once it has expired', async () => {
    await handCode();
    answer = { ok: false, reason: 'hub-unreachable' };
    await sync.sync();
    clockNow = new Date(Date.parse(CODE.expiresAt) + 1);
    expect(await sync.sync()).toMatchObject({ kind: 'waiting' });
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it('drops a code the hub reset, waiting for the new one', async () => {
    await handCode();
    answer = { ok: false, reason: 'already-linked' };
    await sync.sync();
    expect(await sync.sync()).toMatchObject({ kind: 'waiting' });
    expect(redeem).toHaveBeenCalledTimes(1);
  });
});

describe('a moved hub', () => {
  it('saves a new origin only once a handshake there proves the pinned key', async () => {
    await handCode();
    await sync.sync();
    cloud.set({ hubOrigin: 'https://moved.example.invalid' });
    vi.clearAllMocks();
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    expect(checkHost).toHaveBeenCalledWith('https://moved.example.invalid');
    expect(dialer.dialAt).toHaveBeenCalledWith(
      'https://moved.example.invalid',
      expect.any(Function)
    );
    // Not proved yet: the pin keeps the old origin.
    expect(pin).toMatchObject({ hubOrigin: HUB, hubKey: HUB_KEY });
    proved.at(-1)!();
    await vi.waitFor(() => expect(pin?.hubOrigin).toBe('https://moved.example.invalid'));
    expect(pin?.hubKey).toBe(HUB_KEY);
    // No new code: the key stays the one pinned at link time.
    expect(redeem).not.toHaveBeenCalled();
  });

  it('keeps the old origin while a handshake at the new one never proves', async () => {
    await handCode();
    await sync.sync();
    cloud.set({ hubOrigin: 'https://moved.example.invalid' });
    await sync.sync();
    await sync.sync();
    expect(dialer.dialAt).toHaveBeenCalledTimes(2);
    expect(pin?.hubOrigin).toBe(HUB);
  });

  it('sends nothing to a new origin that is not a public one', async () => {
    await handCode();
    await sync.sync();
    cloud.set({ hubOrigin: 'https://moved.example.invalid' });
    checkHost.mockResolvedValue('not-public');
    vi.clearAllMocks();
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    expect(dialer.dialAt).not.toHaveBeenCalled();
    // It keeps dialing the hub where it was proved.
    expect(dialer.dialNow).toHaveBeenCalledTimes(1);
    expect(pin?.hubOrigin).toBe(HUB);
  });

  it('relinks at the new origin when a new code comes with it', async () => {
    await handCode();
    await sync.sync();
    cloud.set({ hubOrigin: 'https://moved.example.invalid' });
    await handCode();
    answer = { ...answer, relaySecret: 'n'.repeat(43) } as RedeemAtHubResult;
    expect(await sync.sync()).toMatchObject({ kind: 'linked' });
    expect(redeem).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: 'https://moved.example.invalid' })
    );
    expect(pin).toMatchObject({
      hubOrigin: 'https://moved.example.invalid',
      relaySecret: 'n'.repeat(43),
    });
  });
});

describe('refusals stop the computer working', () => {
  async function linked() {
    await handCode();
    await sync.sync();
    vi.clearAllMocks();
  }

  async function expectStopped(reason: string) {
    expect(await sync.sync()).toEqual({ kind: 'refused', reason });
    expect(dialer.close).toHaveBeenCalled();
    expect(sync.refused).toBe(reason);
    // For good: no further read, no dial.
    const read = vi.spyOn(cloud, 'readAssignment');
    expect(await sync.sync()).toEqual({ kind: 'refused', reason });
    expect(read).not.toHaveBeenCalled();
    expect(dialer.dialNow).not.toHaveBeenCalled();
  }

  it('when the assignment names a different owner than pinned', async () => {
    await linked();
    cloud.set({ ownerAccountId: 'acct_other' });
    await expectStopped('different-owner');
    expect(pin?.accountId).toBe(OWNER.ownerAccountId);
  });

  it('when the assignment names a different issuer than pinned', async () => {
    await linked();
    cloud.set({ issuer: 'https://id.example.invalid' });
    await expectStopped('different-owner');
  });

  it('when the owner changes before any pin, from the first one seen', async () => {
    expect(await sync.sync()).toMatchObject({ kind: 'waiting' });
    cloud.set({ ownerAccountId: 'acct_other' });
    await expectStopped('different-owner');
  });

  it('when the assignment names a different computer than pinned', async () => {
    await linked();
    cloud.set({ computerId: 'cmp_2' });
    await expectStopped('different-computer');
  });

  it('when the cloud id cannot be carried by the relay', async () => {
    cloud.set({ computerId: 'has a space' });
    await expectStopped('computer-id-unrelayable');
  });

  it('when the pin names no owner', async () => {
    await linked();
    pin = { ...pin!, accountId: undefined, issuer: undefined };
    await expectStopped('pin-without-owner');
  });

  it('when the hub names another owner in its answer', async () => {
    await handCode();
    answer = {
      ok: true,
      answer: {
        v: 1,
        hubKey: HUB_KEY,
        ownerAccountId: 'acct_other',
        issuer: OWNER.issuer,
        signature: 's'.repeat(86),
      },
      relaySecret: 'r'.repeat(43),
    };
    await expectStopped('hub-names-different-owner');
    expect(pin).toBeNull();
  });

  it('when the hub answers a relink with a different key, keeping the pinned one', async () => {
    await linked();
    await handCode();
    answer = {
      ok: true,
      answer: { v: 1, hubKey: 'Z'.repeat(43), ...OWNER, signature: 's'.repeat(86) },
      relaySecret: 'n'.repeat(43),
    };
    await expectStopped('different-hub-key');
    expect(pin).toMatchObject({ hubKey: HUB_KEY, relaySecret: 'r'.repeat(43) });
  });
});
