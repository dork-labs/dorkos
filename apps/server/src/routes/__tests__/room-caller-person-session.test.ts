/**
 * `resolveCaller` once an owner exists (DOR-3330): only the owner's browser
 * session writes in a room as them. A caller with no agent header and no
 * session, or with only a key, still reads as the owner, but a write is
 * refused, 401 `PERSON_SESSION_REQUIRED`, so no program here can post, change
 * members or stop a turn as the person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: { id: 'user_owner' } as { id: string } | null }));
const registry = vi.hoisted(() => ({
  resolveAgent: vi.fn(() => ({ id: 'agent-author', kind: 'agent' })),
  bindOwner: vi.fn(() => ({ id: 'owner-author', kind: 'human' })),
  human: vi.fn(() => ({ id: 'someone', kind: 'human' })),
}));

vi.mock('../../services/core/auth/index.js', () => ({ readOwnerAccount: () => state.owner }));
vi.mock('../../services/rooms/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/rooms/index.js')>()),
  getRoomService: () => ({ authorRegistry: registry }),
  resolveOperatorAuthor: () => ({ id: 'owner-author', kind: 'human' }),
}));

import type { RequestFacts } from '../../http/request-facts.js';
import { resolveCaller } from '../room-caller.js';

/** A caller with no agent header, and the given account. */
function facts(
  user?: RequestFacts['user']
): Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'> {
  return { headers: {}, agentIdentity: undefined, user };
}

beforeEach(() => {
  state.owner = { id: 'user_owner' };
});

describe('resolveCaller with an owner', () => {
  it('lets a caller with no session read as the owner', () => {
    expect(resolveCaller(facts(), 'read').id).toBe('owner-author');
  });

  it('refuses a write with no session: it could be any program here', () => {
    expect(() => resolveCaller(facts(), 'write')).toThrow(
      expect.objectContaining({ code: 'PERSON_SESSION_REQUIRED' })
    );
  });

  it('treats a call that says nothing as a write', () => {
    expect(() => resolveCaller(facts())).toThrow(
      expect.objectContaining({ code: 'PERSON_SESSION_REQUIRED' })
    );
  });

  it('never lets a key write as the owner, though it reads as them', () => {
    const key = { userId: 'user_owner', credential: 'api-key' as const };
    expect(resolveCaller(facts(key), 'read').id).toBe('owner-author');
    expect(() => resolveCaller(facts(key), 'write')).toThrow(
      expect.objectContaining({ code: 'PERSON_SESSION_REQUIRED' })
    );
  });

  it('lets the owner’s browser session write as the owner', () => {
    const session = { userId: 'user_owner', credential: 'cookie' as const };
    expect(resolveCaller(facts(session), 'write').id).toBe('owner-author');
  });
});

describe('resolveCaller with nobody owning this install yet', () => {
  it('lets the person at this computer write, as before', () => {
    state.owner = null;
    expect(resolveCaller(facts(), 'write').id).toBe('owner-author');
  });
});
