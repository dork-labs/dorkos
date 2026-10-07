/**
 * Which space is official, worked out on every read (spec `official-community-space` D4, D5).
 *
 * Each case pins one rule a reviewer named: "official" is never stored and follows the link
 * configured now; a short-name link is matched only through what its own pairing discovered;
 * an empty link turns the exception off; and the answer is in memory, loaded fail-closed.
 *
 * @vitest-environment node
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CredentialStore } from '../../core/credential-provider.js';
import { RemoteConnectionStore } from '../remote/connection-store.js';
import { RemoteWakePolicy } from '../remote/wake-policy.js';
import { OfficialSpace } from '../official-space.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://space.example';
const OFFICIAL = { pinnedOrigin: ORIGIN, remoteCommunityId: ID };
const REF = 'remote_official' as CommunityRef;
const OTHER_REF = 'remote_other' as CommunityRef;

function memoryCredentials(): CredentialStore {
  const secrets = new Map<string, string>();
  return {
    put: async (name, secret) => {
      secrets.set(name, secret);
      return `file:${name}`;
    },
    get: async (name) => secrets.get(name) ?? null,
    delete: async (name) => {
      secrets.delete(name);
    },
  };
}

let home: string;
let link: string;
let spacesOn: boolean;
let official: OfficialSpace;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'official-space-'));
  link = '';
  spacesOn = false;
  official = new OfficialSpace(
    home,
    () => link,
    () => spacesOn
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the official link', () => {
  it('is off while the link is empty', () => {
    expect(official.link()).toBeNull();
    expect(official.origin()).toBeNull();
    expect(official.isOfficialConnection(OFFICIAL)).toBe(false);
  });

  it('is off for a link that is not a space address', () => {
    link = 'not a link';
    expect(official.link()).toBeNull();
    expect(official.isOfficialLink('not a link')).toBe(false);
  });

  it('matches a canonical link by origin and community id', () => {
    link = `${ORIGIN}/c/${ID}`;
    expect(official.isOfficialConnection(OFFICIAL)).toBe(true);
    expect(official.isOfficialConnection({ ...OFFICIAL, remoteCommunityId: OTHER_ID })).toBe(false);
    expect(
      official.isOfficialConnection({ ...OFFICIAL, pinnedOrigin: 'https://evil.example' })
    ).toBe(false);
  });

  it('un-officials a connection the moment the link changes or is cleared', () => {
    link = `${ORIGIN}/c/${ID}`;
    expect(official.isOfficialConnection(OFFICIAL)).toBe(true);
    link = `${ORIGIN}/c/${OTHER_ID}`;
    expect(official.isOfficialConnection(OFFICIAL)).toBe(false);
    link = '';
    expect(official.isOfficialConnection(OFFICIAL)).toBe(false);
  });

  it('compares typed links in any spelling of the same address', () => {
    link = `${ORIGIN}/Makers`;
    expect(official.isOfficialLink(`${ORIGIN}/makers`)).toBe(true);
    expect(official.isOfficialLink(`${ORIGIN}/other`)).toBe(false);
    expect(official.isOfficialLink(`https://elsewhere.example/makers`)).toBe(false);
  });
});

describe('a short-name link', () => {
  it('matches only the community its own pairing discovered', async () => {
    link = `${ORIGIN}/makers`;
    // Before any pairing from the link, nothing can be matched to it.
    expect(official.isOfficialConnection(OFFICIAL)).toBe(false);
    // A pairing from another link records nothing.
    await official.noteDiscovery(`${ORIGIN}/other`, ORIGIN, ID);
    expect(official.isOfficialConnection(OFFICIAL)).toBe(false);

    await official.noteDiscovery(`${ORIGIN}/makers`, ORIGIN, ID);
    expect(official.isOfficialConnection(OFFICIAL)).toBe(true);
    expect(official.isOfficialConnection({ ...OFFICIAL, remoteCommunityId: OTHER_ID })).toBe(false);
  });

  it('survives a restart, and stops answering once the link moves', async () => {
    link = `${ORIGIN}/makers`;
    await official.noteDiscovery(link, ORIGIN, ID);
    const restarted = new OfficialSpace(
      home,
      () => link,
      () => false
    );
    expect(restarted.isOfficialConnection(OFFICIAL)).toBe(true);
    link = `${ORIGIN}/elsewhere`;
    expect(restarted.isOfficialConnection(OFFICIAL)).toBe(false);
  });
});

describe('spaceReachable(ref)', () => {
  it('reaches every space while the experiment is on', () => {
    spacesOn = true;
    expect(official.reachable(OTHER_REF)).toBe(true);
  });

  it('fails closed until the connections have loaded', async () => {
    link = `${ORIGIN}/c/${ID}`;
    expect(official.reachable(REF)).toBe(false);
    await official.load(async () => [{ ref: REF, ...OFFICIAL }]);
    expect(official.reachable(REF)).toBe(true);
  });

  it('reaches only the official space while the experiment is off', async () => {
    link = `${ORIGIN}/c/${ID}`;
    await official.load(async () => [
      { ref: REF, ...OFFICIAL },
      { ref: OTHER_REF, pinnedOrigin: 'https://other.example', remoteCommunityId: OTHER_ID },
    ]);
    expect(official.reachable(REF)).toBe(true);
    expect(official.reachable(OTHER_REF)).toBe(false);
  });

  it('follows connections added and removed after loading', async () => {
    link = `${ORIGIN}/c/${ID}`;
    await official.load(async () => []);
    official.follow([{ ref: REF, status: 'pending', ...OFFICIAL }]);
    expect(official.reachable(REF)).toBe(true);
    official.follow([{ ref: REF, status: 'removed', ...OFFICIAL }]);
    expect(official.reachable(REF)).toBe(false);
  });

  it('keeps a change committed while it was still loading', async () => {
    link = `${ORIGIN}/c/${ID}`;
    await official.load(async () => {
      official.follow([{ ref: REF, status: 'pending', ...OFFICIAL }]);
      return [];
    });
    expect(official.reachable(REF)).toBe(true);
  });
});

describe('the connection store', () => {
  async function storeWithOfficial() {
    const store = new RemoteConnectionStore(home, memoryCredentials(), (place) =>
      official.isOfficialConnection(place)
    );
    for (const [ref, origin, id] of [
      [REF, ORIGIN, ID],
      [OTHER_REF, 'https://other.example', OTHER_ID],
    ] as const) {
      await store.addPending(
        {
          ref,
          ownerKey: 'owner',
          remoteCommunityId: id,
          label: ref,
          pinnedOrigin: origin,
          pairingId: `pairing-${ref}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        'verifier'
      );
    }
    return store;
  }

  it('marks the official row on every read and never writes the mark to disk', async () => {
    link = `${ORIGIN}/c/${ID}`;
    const store = await storeWithOfficial();
    const rows = await store.list('owner');
    expect(rows.find((row) => row.ref === REF)?.official).toBe(true);
    expect(rows.find((row) => row.ref === OTHER_REF)?.official).toBeUndefined();

    const directory = join(home, 'communities', 'remote');
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue;
      expect(await readFile(join(directory, file), 'utf8')).not.toMatch(/"official"\s*:/);
    }

    link = '';
    expect((await store.list('owner')).some((row) => row.official)).toBe(false);
  });

  it('lets only the owner wake agents in the official space unless they choose otherwise', async () => {
    link = `${ORIGIN}/c/${ID}`;
    const store = await storeWithOfficial();
    expect(await store.wakeAgentsFrom(REF, 'owner')).toBe('me');
    expect(await store.wakeAgentsFrom(OTHER_REF, 'owner')).toBe('members');
    await store.setWakeAgentsFrom(REF, 'owner', 'members');
    expect(await store.wakeAgentsFrom(REF, 'owner')).toBe('members');
  });

  it('holds the live gate to the official default, and follows a change of link', async () => {
    link = `${ORIGIN}/c/${ID}`;
    const store = await storeWithOfficial();
    await store.complete(REF, 'owner', 'owner-member', 'token', {
      state: 'verified',
      effective: { read: true, post: true, enrollAgent: true, stream: true },
      lastKnown: {
        lifecycle: 'active',
        capabilities: { read: true, post: true, enrollAgent: true, stream: true },
        verifiedAt: '2026-10-07T00:00:00.000Z',
      },
    });
    await official.load(() => store.places());
    const gate = new RemoteWakePolicy(store, [], (ref) =>
      official.isOfficialRef(ref) ? 'me' : 'members'
    );
    await gate.reload();

    expect(gate.wakes(REF, 'owner', 'stranger')).toBe(false);
    expect(gate.wakes(REF, 'owner', 'owner-member')).toBe(true);
    // The link moves: this is no longer the official space, so today's default applies again.
    link = `${ORIGIN}/c/${OTHER_ID}`;
    expect(gate.wakes(REF, 'owner', 'stranger')).toBe(true);
  });
});
