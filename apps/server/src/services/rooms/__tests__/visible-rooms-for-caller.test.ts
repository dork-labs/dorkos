/**
 * `visibleRoomsForCaller`, against a real `RoomService` over a real database
 * (DOR-2055).
 *
 * ## Why this file exists at all
 *
 * The two sidebar-section capabilities check a room reference against "the rooms
 * you can see", and every test of those capabilities injects its own roster, so
 * none of them touches the line that decides WHOSE rooms those are. Review
 * measured the gap: reverting the caller resolution to the install owner's left
 * 712 tests green. This file is the one that goes red — it drives the real
 * author registry, the real membership rows and the real `listRooms`, so the
 * owner's `seesEveryRoom` and an agent's roster scoping are measured rather than
 * asserted about a fake.
 *
 * The negative that matters most is the last one: the owner CAN see the
 * agent-to-agent DM that the agent cannot. Without it, "the agent sees one room"
 * would pass just as well on an install that only had one room.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authors as authorsTable } from '@dorkos/db';

import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import { visibleRoomsForCaller } from '../visible-rooms-for-caller.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';

/**
 * The two install facts `callerAuthor` reads, stubbed exactly as
 * `member-rooms.test.ts` stubs them: both live outside the rooms domain and are
 * read per call.
 */
const installState: { ownerId: string | null; loginEnabled: boolean } = {
  ownerId: null,
  loginEnabled: false,
};

vi.mock('../../core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/index.js')>()),
  readOwnerAccount: () => (installState.ownerId ? { id: installState.ownerId } : null),
}));

vi.mock('../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) =>
      section === 'auth' ? { enabled: installState.loginEnabled } : undefined,
    set: () => {},
  },
}));

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

/** Ana, as an agent that presented a valid identity token. */
const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  tierCeiling: 'act',
  createdAt: '2026-09-15T09:00:00.000Z',
};

let harness: RoomHarness;
let service: RoomService;
let authors: AuthorRegistry;
let human: string;
let ana: string;
let bo: string;

/** The room Ana is seated in. */
let anasChannel: string;
/** A channel nobody seated Ana in. */
let othersChannel: string;
/** A direct message between two AGENTS — the room a leak would expose. */
let agentDm: string;

beforeEach(() => {
  installState.ownerId = null;
  installState.loginEnabled = false;
  harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
  ({ service, authors, human } = harness);
  ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  bo = authors.resolveAgent('/agents/bo', 'Bo').id;

  anasChannel = service.createRoom(
    { kind: 'channel', title: 'lab', slug: 'lab', members: [], agentPaths: ['/agents/ana'] },
    human
  ).id;
  othersChannel = service.createRoom(
    { kind: 'channel', title: 'payroll', slug: 'payroll', members: [], agentPaths: [] },
    human
  ).id;
  // Ana is deliberately NOT in this one, and neither is it a room she could
  // reach any other way. It is the operator's private conversation with Bo.
  agentDm = service.createRoom(
    { kind: 'dm', title: 'Bo', members: [], agentPaths: ['/agents/bo'] },
    human
  ).id;
});

/** The caller context an identified agent arrives with. */
function asAgent(over: Partial<AgentIdentity> = {}): CapabilityHandlerContext {
  return { identity: { ...ANA, ...over } };
}

/** Just the ids, sorted, so a comparison reads as a set. */
function idsFor(caller: CapabilityHandlerContext): string[] | undefined {
  return visibleRoomsForCaller(service, caller)
    ?.map((room) => room.roomId)
    .sort();
}

describe('visibleRoomsForCaller', () => {
  it('shows an agent only the rooms it is seated in', () => {
    expect(idsFor(asAgent())).toEqual([anasChannel]);
  });

  it('shows the owner every room, the agent-to-agent DM included', () => {
    // The positive control for the case above, and the reason it is not
    // vacuous: these rooms exist and are listable — just not by Ana. A caller
    // with no agent identity, on an install with login off, IS the owner
    // (`callerAuthor`'s last branch), and `seesEveryRoom` does the rest.
    expect(idsFor({})).toEqual([agentDm, anasChannel, othersChannel].sort());
    expect(idsFor({})).toContain(agentDm);
    expect(idsFor(asAgent())).not.toContain(agentDm);
  });

  it('follows a membership change rather than a captured list', () => {
    // A room an agent is added to shows up on the next call, and one it is taken
    // out of stops showing — which is what makes reading this per call, rather
    // than once at boot, load-bearing.
    harness.store.addMember({
      roomId: othersChannel,
      authorId: ana,
      responseMode: 'mention-only',
      joinedAt: '2026-09-15T09:00:00.000Z',
    });
    expect(idsFor(asAgent())).toEqual([anasChannel, othersChannel].sort());
  });

  it('leaves out an archived room', () => {
    service.updateRoom(anasChannel, human, { archived: true });
    expect(idsFor(asAgent())).toEqual([]);
  });

  it('answers `undefined` for an identity that was revoked or expired', () => {
    // `callerAuthor` throws `AGENT_IDENTITY_UNVERIFIED` for an identity marked
    // inactive, and this must come back as "cannot answer" — never as an empty
    // list, which downstream reads as "no such room" and is a wrong answer
    // rather than a refusal.
    expect(visibleRoomsForCaller(service, asAgent({ inactive: 'revoked' }))).toBeUndefined();
    expect(visibleRoomsForCaller(service, asAgent({ inactive: 'expired' }))).toBeUndefined();
  });

  it('answers `undefined` when a machine claimed the call but resolved to nobody', () => {
    // The `agentIdentityPresented` branch: a token this install could not verify
    // must not fall through to the owner's view.
    expect(visibleRoomsForCaller(service, { agentIdentityPresented: true })).toBeUndefined();
  });

  it('answers `undefined` when the store itself fails', () => {
    // The catch is total on purpose: the decision this feeds is "may I store a
    // reference to this room", and the honest answer to a store that just threw
    // is the same as the answer to a revoked token.
    const broken = {
      ...service,
      authorRegistry: service.authorRegistry,
      listRooms: () => {
        throw new Error('database is gone');
      },
    } as unknown as RoomService;
    expect(visibleRoomsForCaller(broken, asAgent())).toBeUndefined();
  });

  it('carries the title and the slug each room is actually named by', () => {
    // Both are match keys for `sidebar_add_to_group`, so a row that dropped one
    // would silently stop resolving rooms by that name.
    const dm = visibleRoomsForCaller(service, {})!.find((room) => room.roomId === agentDm)!;
    const channel = visibleRoomsForCaller(service, {})!.find(
      (room) => room.roomId === anasChannel
    )!;
    expect(channel).toEqual({ roomId: anasChannel, name: 'lab', slug: 'lab' });
    expect(dm.slug).toBeNull();
    expect(dm.name).toBeTruthy();
  });

  it('mints the caller’s author row, which is a WRITE and not a read', () => {
    // Stated as a test because the function reads like a lookup. `callerAuthor`
    // upserts through `resolveAgent`, so the first call from a principal this
    // database has never seen creates its row — the same write every room verb
    // already performs, and the reason this cannot run on a read-only database.
    //
    // Counted off the table rather than asked of the registry: every read method
    // there either mints or answers a narrower question, so the row count is the
    // one observation that cannot be satisfied by the thing under test.
    const fresh = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    const countAuthors = (): number => fresh.db.select().from(authorsTable).all().length;
    const before = countAuthors();

    visibleRoomsForCaller(fresh.service, {
      identity: { ...ANA, agentPath: '/agents/bo', displayName: 'Bo' },
    });

    expect(countAuthors()).toBe(before + 1);
    // …and it is an UPSERT, so asking twice does not mint twice.
    visibleRoomsForCaller(fresh.service, {
      identity: { ...ANA, agentPath: '/agents/bo', displayName: 'Bo' },
    });
    expect(countAuthors()).toBe(before + 1);
  });

  it('is measured against Bo as well, so the scoping is not Ana-shaped', () => {
    // Two different agents seeing two different sets is what says the caller id
    // is actually threaded through — a unit that ignored it would hand both the
    // same list.
    harness.store.addMember({
      roomId: othersChannel,
      authorId: bo,
      responseMode: 'mention-only',
      joinedAt: '2026-09-15T09:00:00.000Z',
    });
    const anaSees = idsFor(asAgent());
    const boSees = idsFor({ identity: { ...ANA, agentPath: '/agents/bo', displayName: 'Bo' } });

    expect(anaSees).toEqual([anasChannel]);
    expect(boSees).toEqual([agentDm, othersChannel].sort());
    expect(anaSees).not.toEqual(boSees);
  });
});
