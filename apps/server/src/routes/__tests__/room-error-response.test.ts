/**
 * `roomErrorProblem` — what a refusal says to whom (DOR-2457, DOR-4979).
 *
 * The one refusal worded per caller is a room whose git settings name a
 * program: the operator gets the settings file, the keys and a command; anybody
 * else gets a plain line. These pin the direction it fails in when nobody was
 * resolved at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthorRecord } from '../../services/rooms/index.js';

const owner = { ownerId: null as string | null, reads: 0, fails: false };

vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => {
    owner.reads += 1;
    if (owner.fails) throw new Error('database is locked');
    return owner.ownerId ? { id: owner.ownerId } : null;
  },
}));

import {
  isOwnerCaller,
  PROBLEM_BY_CODE,
  roomErrorProblem,
  roomErrorStatus,
} from '../room-error-response.js';
import { PROBLEM_CODES, type ProblemCode } from '@dorkos/shared/problem';
import {
  ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
  RoomError,
  RoomRepoConfigUnsafeError,
} from '../../services/rooms/room-errors.js';

const CONFIG = '/home/operator/.dork/rooms/r1/repo/.git/config';

/** The problem a route sends for `err`, asking whether `caller` is the owner as a route does. */
function reply(err: unknown, caller?: AuthorRecord) {
  return roomErrorProblem(err, 'test', () => isOwnerCaller(caller));
}

/** An author row of the given kind and natural key. */
function author(kind: AuthorRecord['kind'], naturalKey: string): AuthorRecord {
  return { id: `a-${naturalKey}`, kind, naturalKey } as AuthorRecord;
}

beforeEach(() => {
  owner.ownerId = null;
  owner.reads = 0;
  owner.fails = false;
});

describe('roomErrorProblem', () => {
  const unsafe = () => new RoomRepoConfigUnsafeError(CONFIG, ['filter.x.smudge']);

  it('tells a caller nobody resolved only that the files are paused', () => {
    const answer = reply(unsafe());
    expect(answer).toMatchObject({
      status: 409,
      code: 'room_repo_config_unsafe',
      detail: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
    });
    expect(answer).not.toHaveProperty('command');
  });

  it('tells an agent and another person the same plain line', () => {
    owner.ownerId = 'owner-account';
    for (const caller of [author('agent', '/agents/ana'), author('human', 'user:priya')]) {
      const answer = reply(unsafe(), caller);
      expect(answer).toMatchObject({
        code: 'room_repo_config_unsafe',
        detail: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
      });
      expect(answer).not.toHaveProperty('command');
    }
  });

  it('tells the owner the file and the key, with the command in its own field', () => {
    owner.ownerId = 'owner-account';
    expect(reply(unsafe(), author('human', 'user:owner-account'))).toMatchObject({
      code: 'room_repo_config_unsafe',
      detail: expect.stringContaining(CONFIG),
      command: `git config --file '${CONFIG}' --unset-all 'filter.x.smudge'`,
    });
  });

  it('says every other refusal the same to everyone, without reading the owner account', () => {
    owner.fails = true;
    expect(
      reply(new RoomError('ROOM_NOT_FOUND', 'No such room'), author('human', 'user:owner-account'))
    ).toMatchObject({ status: 404, code: 'room_not_found', detail: 'No such room' });
    expect(owner.reads).toBe(0);
  });

  it('still answers, with the plain line, when the owner account cannot be read', () => {
    owner.fails = true;
    expect(reply(unsafe(), author('human', 'user:owner-account'))).toMatchObject({
      status: 409,
      code: 'room_repo_config_unsafe',
      detail: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
    });
  });

  it('answers anything that is not a room refusal with a bare internal_error', () => {
    expect(reply(new Error('/secret/path broke'))).toEqual(
      expect.objectContaining({ status: 500, code: 'internal_error' })
    );
    expect(reply(new Error('/secret/path broke'))).not.toHaveProperty('detail');
  });
});

describe('PROBLEM_BY_CODE', () => {
  it('maps every room code onto a problem code the list holds', () => {
    for (const [roomCode, mapped] of Object.entries(PROBLEM_BY_CODE)) {
      expect(PROBLEM_CODES[mapped.code as ProblemCode], roomCode).toBeDefined();
    }
  });

  it('keeps the status each refusal answered with before the problem shape', () => {
    expect(roomErrorStatus('ROOM_NOT_FOUND')).toBe(404);
    expect(roomErrorStatus('PEOPLE_ONLY')).toBe(403);
    expect(roomErrorStatus('MERGE_IN_FLIGHT')).toBe(429);
    expect(roomErrorStatus('CANVAS_UNAVAILABLE')).toBe(503);
    expect(roomErrorStatus('AGENT_IDENTITY_UNVERIFIED')).toBe(401);
  });
});
