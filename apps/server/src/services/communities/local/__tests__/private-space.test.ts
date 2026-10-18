/**
 * @vitest-environment node
 *
 * A hub's one space is private (spec A6, DOR-2938): just its owner and the
 * owner's agents. Nobody else can be in it, so each way someone else could get
 * in is pinned here as a refusal:
 *
 * - **No second account.** Sign-up is closed for every caller once the hub has
 *   its owner, provisioning included.
 * - **No invite or join.** The local community declares no invite, and no route
 *   serves an invite, a join or a share link for local rooms.
 * - **No outside member.** A room refuses a member nobody created, and a
 *   person a chat bridge brought in cannot be added to any other room.
 * - **It says so.** It is registered as "Private", not as a machine.
 *
 * Pairing only by the owner's own computers is pinned beside its routes: a link
 * code is minted only from the owner's own browser sign-in
 * (`routes/__tests__/hub-computers-gate.test.ts`), and a computer redeems it
 * once (`routes/__tests__/hub-link.test.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_COMMUNITY } from '@dorkos/shared/community-adapter';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

import { decideRegistration, registrationAllowed } from '../../../core/auth/registration-policy.js';
import { CommunityRegistry } from '../../registry.js';
import { RoomStore } from '../../../rooms/room-store.js';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { LOCAL_CAPABILITIES } from '../local-capabilities.js';
import { HUB_LOCAL_COMMUNITY_LABEL, registerLocalCommunity } from '../register-local-community.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const routeCensus = JSON.parse(
  fs.readFileSync(path.join(here, '../../../../http/__tests__/route-census.baseline.json'), 'utf8')
) as { routes: string[] };

describe('the private space on a hub', () => {
  it('lets nobody make a second account once the owner exists', () => {
    for (const caller of [
      'provisioning',
      'in-process',
      { kind: 'this-computer' },
      { kind: 'other-device' },
    ] as const) {
      const mode = decideRegistration({ caller, hasUsers: true, role: 'hub' } as never);
      expect(mode, JSON.stringify(caller)).toBe('closed');
      expect(registrationAllowed(mode, caller as never)).toBe(false);
    }
  });

  it('declares no invite, and admits no agent of anyone else', () => {
    expect(LOCAL_CAPABILITIES.invite).toBe('none');
    expect(LOCAL_CAPABILITIES.agentAdmission).toBe('none');
  });

  it('serves no invite, join or share link for its own rooms', () => {
    // `/api/communities/:ref/…` is the person's membership of OTHER spaces,
    // never a way into this one.
    const local = routeCensus.routes.filter((route) => !route.includes('/api/communities/'));
    const ways_in = local.filter((route) => /invit|join|share|guest|public-link/i.test(route));
    expect(ways_in).toEqual([]);
  });

  it('refuses a room member nobody created', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Plans', members: [], agentPaths: [] },
      harness.human
    );
    expect(() =>
      harness.service.addMember(room.id, harness.human, { authorId: 'someone-else' })
    ).toThrow(expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }));
    expect(harness.service.getRoom(room.id, harness.human)?.members.map((m) => m.authorId)).toEqual(
      [harness.human]
    );
  });

  it('keeps a person from a chat bridge out of every other room', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const stranger = harness.authors.resolveExternal({
      platformType: 'telegram',
      instanceId: 'bot',
      platformUserId: '999',
      displayName: 'Mallory',
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Plans', members: [], agentPaths: [] },
      harness.human
    );
    expect(() =>
      harness.service.addMember(room.id, harness.human, { authorId: stranger.id })
    ).toThrow(expect.objectContaining({ code: 'PRIVATE_SPACE' }));
    expect(() =>
      harness.service.createRoom(
        { kind: 'channel', title: 'Side chat', members: [stranger.id], agentPaths: [] },
        harness.human
      )
    ).toThrow(expect.objectContaining({ code: 'PRIVATE_SPACE' }));
    expect(harness.service.listRooms(harness.human).map((r) => r.title)).not.toContain('Side chat');

    // On a person's own computer, who they bring in is theirs to decide.
    role.value = 'computer';
    try {
      harness.service.addMember(room.id, harness.human, { authorId: stranger.id });
      expect(
        harness.service.getRoom(room.id, harness.human)?.members.map((m) => m.authorId)
      ).toContain(stranger.id);
    } finally {
      role.value = 'hub';
    }
  });

  it('is registered as Private, not as a machine', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const registry = new CommunityRegistry();
    await registerLocalCommunity({
      service: harness.service,
      store: new RoomStore(harness.db),
      authors: harness.authors,
      registry,
    });
    expect(registry.list()).toEqual([
      { community: LOCAL_COMMUNITY, label: HUB_LOCAL_COMMUNITY_LABEL, type: 'local' },
    ]);
  });
});
