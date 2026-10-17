/**
 * @vitest-environment node
 *
 * Linking this computer to its hub (DOR-2946), against a fake hub built from
 * the hub's own checks: it verifies the request with `verifyRelayLinkRequest`
 * and signs with `relayLinkAnswerBytes`, exactly as `routes/hub-link.ts` does,
 * so a pass here means both ends agree on the transcripts.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  RelayLinkRequestSchema,
  type RelayLinkRequest,
  type RelayLinkResponse,
} from '@dorkos/shared/session-relay-link';
import { pinnableKey } from '../channel.js';
import {
  relayLinkAnswerBytes,
  relayLinkCodeHash,
  verifyRelayLinkRequest,
} from '../link-signature.js';
import { computerPublicKey, readRelayPin } from '../pin-store.js';
import {
  accountMatches,
  isLocalHostName,
  isNonPublicAddress,
  linkToHub,
  RELAY_LINK_MAX_RESPONSE_BYTES,
  type CloudLinkIdentity,
} from '../relay-link.js';
import { relaySecretHash } from '../../hub-relay/computer-store.js';

const ORIGIN = 'https://me.dorkos.test';
const CODE = '7K3M-Q9TD-X2HV-8RNB';
const LINK_CODE = `${CODE}@me.dorkos.test`;
const NOT_LINKED = async (): Promise<CloudLinkIdentity> => ({ linked: false });
/** A hub on the internet, as DNS would answer for it. */
const PUBLIC = async () => [{ address: '203.0.113.10' }];

/** {@link linkToHub}, resolving every host to a public address unless told otherwise. */
function link(...[input, deps]: Parameters<typeof linkToHub>) {
  return linkToHub(input, { lookup: PUBLIC, ...deps });
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-link-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** What the fake hub does with a request it accepts. */
interface FakeHubOptions {
  /** The key it signs with; its own by default. */
  signWith?: KeyObject;
  /** The owner it names. */
  owner?: { ownerAccountId: string; issuer: string };
}

/** A hub answering `POST /api/hub/link` with the hub's own checks. */
function fakeHub(options: FakeHubOptions = {}) {
  const hubKey = generateKeyPairSync('ed25519').privateKey;
  const seen: RelayLinkRequest[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = RelayLinkRequestSchema.parse(JSON.parse(String(init?.body)));
    seen.push(request);
    const origin = ORIGIN;
    const codeHash = relayLinkCodeHash(request.code);
    if (!verifyRelayLinkRequest(request, origin, codeHash)) {
      return Response.json({ error: 'no', code: 'LINK_REFUSED' }, { status: 401 });
    }
    const answer: Omit<RelayLinkResponse, 'signature'> = {
      v: 1,
      hubKey: pinnableKey(hubKey),
      ...(options.owner ?? {}),
    };
    const signature = sign(
      null,
      relayLinkAnswerBytes(request, origin, codeHash, answer),
      options.signWith ?? hubKey
    ).toString('base64url');
    return Response.json({ ...answer, signature });
  });
  return { hubKey, seen, fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch };
}

/** A hub that answers with a fixed response. */
function answering(response: () => Response) {
  const calls = vi.fn(async () => response());
  return { fetch: calls as unknown as typeof globalThis.fetch, calls };
}

const NAME = 'Studio Mac';

describe('linkToHub', () => {
  it('links over https without following redirects, and pins the key the hub signed with', async () => {
    const hub = fakeHub();
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED }
    );
    expect(result.ok).toBe(true);

    const [url, init] = hub.calls.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/hub/link`);
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const pin = readRelayPin(home)!;
    expect(pin).toMatchObject({
      v: 2,
      hubOrigin: ORIGIN,
      hubKey: pinnableKey(hub.hubKey),
      computerName: NAME,
      level: 'chat',
      paused: false,
    });
    expect(pin.computerId).toMatch(/^mac-[0-9a-z]{16}$/);
    // The hub got this computer's own key and only a hash of the secret, and
    // that hash is exactly what the hub's relay endpoint will check the dial against.
    const sent = hub.seen[0]!;
    expect(sent.computerKey).toBe(computerPublicKey(home));
    expect(sent.secretHash).toBe(relaySecretHash(pin.relaySecret));
    expect(JSON.stringify(sent)).not.toContain(pin.relaySecret);
  });

  it('keeps the same computer id when linking again after an unlink', async () => {
    const first = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: fakeHub().fetch, cloudIdentity: NOT_LINKED }
    );
    fs.rmSync(path.join(home, 'session-relay', 'pin.json'));
    const second = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: fakeHub().fetch, cloudIdentity: NOT_LINKED }
    );
    expect(first.ok && second.ok && first.pin.computerId === second.pin.computerId).toBe(true);
  });

  it('uses the Cloud instance id, and keeps the hub owner’s account when it matches', async () => {
    const hub = fakeHub({
      owner: { ownerAccountId: 'acct_me', issuer: 'https://accounts.dorkos.test' },
    });
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hub.fetch,
        cloudIdentity: async () => ({
          linked: true,
          instanceId: 'inst_42',
          accountKey: 'acct_me',
          issuer: null,
        }),
      }
    );
    expect(result.ok).toBe(true);
    expect(readRelayPin(home)).toMatchObject({
      computerId: 'inst_42',
      accountId: 'acct_me',
      issuer: 'https://accounts.dorkos.test',
    });
  });

  it('refuses a hub owned by a different DorkOS account, and pins nothing', async () => {
    const hub = fakeHub({
      owner: { ownerAccountId: 'acct_someone', issuer: 'https://accounts.dorkos.test' },
    });
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hub.fetch,
        cloudIdentity: async () => ({
          linked: true,
          instanceId: 'inst_42',
          accountKey: 'acct_me',
          issuer: null,
        }),
      }
    );
    expect(result).toEqual({ ok: false, reason: 'different-account' });
    expect(readRelayPin(home)).toBeNull();
  });

  it('refuses when this computer’s own DorkOS account cannot be read', async () => {
    const hub = fakeHub();
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hub.fetch,
        cloudIdentity: async () => ({
          linked: true,
          instanceId: null,
          accountKey: null,
          issuer: null,
        }),
      }
    );
    expect(result).toEqual({ ok: false, reason: 'account-unreadable' });
    expect(hub.calls).not.toHaveBeenCalled();
  });

  it('refuses an answer not signed by the key the hub hands over', async () => {
    const hub = fakeHub({ signWith: generateKeyPairSync('ed25519').privateKey });
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED }
    );
    expect(result).toEqual({ ok: false, reason: 'signature-failed' });
    expect(readRelayPin(home)).toBeNull();
  });

  it('refuses an answer signed for another origin', async () => {
    // A hub that signs, with the key it hands over, over a different origin.
    const relaxed = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = RelayLinkRequestSchema.parse(JSON.parse(String(init?.body)));
      const codeHash = relayLinkCodeHash(request.code);
      const key = generateKeyPairSync('ed25519').privateKey;
      const answer = { v: 1 as const, hubKey: pinnableKey(key) };
      const signature = sign(
        null,
        relayLinkAnswerBytes(request, 'https://elsewhere.test', codeHash, answer),
        key
      ).toString('base64url');
      return Response.json({ ...answer, signature });
    });
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: relaxed as unknown as typeof fetch, cloudIdentity: NOT_LINKED }
    );
    expect(result).toEqual({ ok: false, reason: 'signature-failed' });
  });

  it.each([
    ['a redirect', 302, 'hub-unreachable'],
    ['a used code', 401, 'hub-refused'],
    ['a computer already linked there', 409, 'already-linked'],
    ['a hub that is not serving', 503, 'hub-unreachable'],
  ])('maps %s to a plain refusal, and pins nothing', async (_label, status, reason) => {
    const hub = answering(
      () =>
        new Response(JSON.stringify({ error: 'x', code: 'x' }), {
          status,
          headers: status === 302 ? { location: 'https://evil.test/api/hub/link' } : {},
        })
    );
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED }
    );
    expect(result).toEqual({ ok: false, reason });
    expect(hub.calls).toHaveBeenCalledTimes(1);
    expect(readRelayPin(home)).toBeNull();
  });

  it.each([
    ['plain http', `${CODE}@http://me.dorkos.test`],
    ['a path', `${CODE}@me.dorkos.test/elsewhere`],
    ['no host', CODE],
    ['not a code', 'hello@me.dorkos.test'],
  ])('refuses %s before sending anything', async (_label, linkCode) => {
    const hub = fakeHub();
    const result = await link(
      { linkCode, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED }
    );
    expect(result).toEqual({ ok: false, reason: 'bad-code' });
    expect(hub.calls).not.toHaveBeenCalled();
  });

  it('gives up on a hub that does not answer in time', async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })
    );
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hang as unknown as typeof fetch,
        cloudIdentity: NOT_LINKED,
        timeoutMs: 30,
      }
    );
    expect(result).toEqual({ ok: false, reason: 'hub-unreachable' });
  });

  it('stops reading an answer past the size cap', async () => {
    const hub = answering(
      () => new Response('x'.repeat(RELAY_LINK_MAX_RESPONSE_BYTES + 1), { status: 200 })
    );
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED }
    );
    expect(result).toEqual({ ok: false, reason: 'hub-unreachable' });
  });

  it('refuses while this computer is already linked, without asking the hub', async () => {
    const first = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: fakeHub().fetch, cloudIdentity: NOT_LINKED }
    );
    expect(first.ok).toBe(true);
    const hub = fakeHub();
    const again = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED }
    );
    expect(again).toEqual({ ok: false, reason: 'already-linked' });
    expect(hub.calls).not.toHaveBeenCalled();
  });

  it('refuses a hub that names no owner, on a computer linked to a DorkOS account', async () => {
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: fakeHub().fetch,
        cloudIdentity: async () => ({
          linked: true,
          instanceId: 'inst_42',
          accountKey: 'acct_me',
          issuer: null,
        }),
      }
    );
    expect(result).toEqual({ ok: false, reason: 'different-account' });
    expect(readRelayPin(home)).toBeNull();
  });

  it.each([
    ['this computer', `${CODE}@localhost`],
    ['a .localhost name', `${CODE}@hub.localhost`],
    ['an IP literal', `${CODE}@203.0.113.10`],
    ['a .local name', `${CODE}@studio.local`],
    ['an .internal name', `${CODE}@hub.corp.internal`],
  ])('refuses a code naming %s before sending anything', async (_label, linkCode) => {
    const hub = fakeHub();
    const lookup = vi.fn(PUBLIC);
    const result = await link(
      { linkCode, computerName: NAME },
      { dorkHome: home, fetch: hub.fetch, cloudIdentity: NOT_LINKED, lookup }
    );
    expect(result).toEqual({ ok: false, reason: 'not-public' });
    expect(hub.calls).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.20',
    '172.20.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ])('refuses a hub name that resolves to %s', async (address) => {
    const hub = fakeHub();
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hub.fetch,
        cloudIdentity: NOT_LINKED,
        // One public address beside it is not enough.
        lookup: async () => [{ address: '203.0.113.10' }, { address }],
      }
    );
    expect(result).toEqual({ ok: false, reason: 'not-public' });
    expect(hub.calls).not.toHaveBeenCalled();
  });

  it('answers unreachable for a hub name that does not resolve', async () => {
    const hub = fakeHub();
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hub.fetch,
        cloudIdentity: NOT_LINKED,
        lookup: async () => {
          throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
        },
      }
    );
    expect(result).toEqual({ ok: false, reason: 'hub-unreachable' });
    expect(hub.calls).not.toHaveBeenCalled();
  });
});

describe('what counts as off the internet', () => {
  it('reads host names and addresses', () => {
    expect(isLocalHostName('me.dorkos.app')).toBe(false);
    expect(isLocalHostName('LOCALHOST')).toBe(true);
    expect(isLocalHostName('[::1]')).toBe(true);
    expect(isLocalHostName('printer.home.arpa')).toBe(true);
    expect(isNonPublicAddress('203.0.113.10')).toBe(false);
    expect(isNonPublicAddress('2606:4700::1')).toBe(false);
    expect(isNonPublicAddress('0.0.0.0')).toBe(true);
  });
});

describe('accountMatches: a check against the wrong hub, not proof of ownership', () => {
  const me = { linked: true as const, instanceId: 'inst_42', accountKey: 'acct_me' };
  const ISSUER = 'https://id.dorkos.test';

  it('needs the same account id and an issuer, and the same issuer once known', () => {
    expect(
      accountMatches({ ...me, issuer: null }, { ownerAccountId: 'acct_me', issuer: ISSUER })
    ).toBe(true);
    expect(
      accountMatches({ ...me, issuer: ISSUER }, { ownerAccountId: 'acct_me', issuer: `${ISSUER}/` })
    ).toBe(true);
    expect(
      accountMatches(
        { ...me, issuer: ISSUER },
        { ownerAccountId: 'acct_me', issuer: 'https://id.evil.test' }
      )
    ).toBe(false);
    expect(accountMatches({ ...me, issuer: null }, { ownerAccountId: 'acct_me' })).toBe(false);
    expect(
      accountMatches({ ...me, issuer: ISSUER }, { ownerAccountId: 'acct_someone', issuer: ISSUER })
    ).toBe(false);
    expect(accountMatches({ ...me, issuer: ISSUER }, {})).toBe(false);
  });

  it('refuses a hub naming another issuer, and pins nothing', async () => {
    const hub = fakeHub({ owner: { ownerAccountId: 'acct_me', issuer: 'https://id.evil.test' } });
    const result = await link(
      { linkCode: LINK_CODE, computerName: NAME },
      {
        dorkHome: home,
        fetch: hub.fetch,
        cloudIdentity: async () => ({ ...me, issuer: ISSUER }),
      }
    );
    expect(result).toEqual({ ok: false, reason: 'different-account' });
    expect(readRelayPin(home)).toBeNull();
  });
});
