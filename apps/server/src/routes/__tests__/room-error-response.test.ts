/**
 * `sendRoomError` — what a refusal says to whom (DOR-2457).
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

import { sendRoomError } from '../room-error-response.js';
import { ROOM_CALLER_LOCAL } from '../room-caller-local.js';
import {
  ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
  RoomError,
  RoomRepoConfigUnsafeError,
} from '../../services/rooms/room-errors.js';

const CONFIG = '/home/operator/.dork/rooms/r1/repo/.git/config';

/** A response that records what it was sent, with the given locals. */
function recorder(locals: Record<string, unknown>) {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    locals,
    status(code: number) {
      sent.status = code;
      return { json: (body: unknown) => void (sent.body = body) };
    },
  };
  return { res: res as never, sent };
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

describe('sendRoomError', () => {
  const unsafe = () => new RoomRepoConfigUnsafeError(CONFIG, ['filter.x.smudge']);

  it('tells a caller nobody resolved only that the files are paused', () => {
    const { res, sent } = recorder({});
    sendRoomError(res, unsafe(), 'test');
    expect(sent).toEqual({
      status: 409,
      body: { code: 'ROOM_REPO_CONFIG_UNSAFE', error: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE },
    });
  });

  it('tells an agent and another person the same plain line', () => {
    owner.ownerId = 'owner-account';
    for (const caller of [author('agent', '/agents/ana'), author('human', 'user:priya')]) {
      const { res, sent } = recorder({ [ROOM_CALLER_LOCAL]: caller });
      sendRoomError(res, unsafe(), 'test');
      expect(sent.body).toEqual({
        code: 'ROOM_REPO_CONFIG_UNSAFE',
        error: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
      });
    }
  });

  it('tells the owner the file and the key, with the command in its own field', () => {
    owner.ownerId = 'owner-account';
    const { res, sent } = recorder({ [ROOM_CALLER_LOCAL]: author('human', 'user:owner-account') });
    sendRoomError(res, unsafe(), 'test');
    expect(sent.body).toEqual({
      code: 'ROOM_REPO_CONFIG_UNSAFE',
      error: expect.stringContaining(CONFIG),
      command: `git config --file '${CONFIG}' --unset-all 'filter.x.smudge'`,
    });
  });

  it('says every other refusal the same to everyone, without reading the owner account', () => {
    const { res, sent } = recorder({ [ROOM_CALLER_LOCAL]: author('human', 'user:owner-account') });
    owner.fails = true;
    sendRoomError(res, new RoomError('ROOM_NOT_FOUND', 'No such room'), 'test');
    expect(sent).toEqual({ status: 404, body: { code: 'ROOM_NOT_FOUND', error: 'No such room' } });
    expect(owner.reads).toBe(0);
  });

  it('still answers, with the plain line, when the owner account cannot be read', () => {
    owner.fails = true;
    const { res, sent } = recorder({ [ROOM_CALLER_LOCAL]: author('human', 'user:owner-account') });
    expect(() => sendRoomError(res, unsafe(), 'test')).not.toThrow();
    expect(sent).toEqual({
      status: 409,
      body: { code: 'ROOM_REPO_CONFIG_UNSAFE', error: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE },
    });
  });
});
