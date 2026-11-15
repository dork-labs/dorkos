/** Room stranger classification and carried marks without a database-backed harness. */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import { strangerMarkForEntries } from '../limits/turn-ceiling.js';
import { turnBoundsOf } from '../limits/teammate-turn.js';
import { lastTurnLevelOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';

const record = (
  id: string,
  kind: AuthorRecord['kind'],
  naturalKey: string,
  linkedOwnerKey: string | null = null
): AuthorRecord => ({
  id,
  kind,
  naturalKey,
  displayName: id,
  handle: null,
  emoji: null,
  color: null,
  imageUrl: null,
  mintedForManifestId: null,
  linkedOwnerKey,
});

const owner = record('owner', 'human', 'user:owner-account');
const teammate = record('teammate', 'human', 'user:teammate-account');
const agent = record('agent', 'agent', '/agents/bolt');
const bridgedPhone = record(
  'phone',
  'human',
  'platform:telegram:bot-example:phone-7',
  'user:owner-account'
);
const records = new Map([owner, teammate, agent, bridgedPhone].map((one) => [one.id, one]));
const authors = {
  getMany: (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (records.has(id) ? [[id, records.get(id)!]] : []))),
} as unknown as AuthorRegistry;
const isOwner = (authorId: string) => authorId === owner.id;

/** Record the Full level produced by one room turn option set. */
function levelFor(carriedOutsider?: true): TurnPermissionLevel {
  const sessionId = `room-classification-${carriedOutsider ? 'marked' : 'owner'}`;
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  runtime.sendMessage(
    sessionId,
    'made-up room message',
    turnBoundsOf({
      additionalDirectories: [],
      ...(carriedOutsider ? { carriedOutsider } : {}),
    })
  );
  return lastTurnLevelOf(sessionId)!;
}

describe('room stranger classification (DOR-3858)', () => {
  it('marks only non-owner people when enabled, including a linked bridged phone', () => {
    expect(strangerMarkForEntries(true, authors, [{ authorId: owner.id }], isOwner)).toEqual({});
    expect(strangerMarkForEntries(true, authors, [{ authorId: agent.id }], isOwner)).toEqual({});
    expect(strangerMarkForEntries(true, authors, [{ authorId: teammate.id }], isOwner)).toEqual({
      carriedOutsider: true,
    });
    expect(strangerMarkForEntries(true, authors, [{ authorId: bridgedPhone.id }], isOwner)).toEqual(
      {
        carriedOutsider: true,
      }
    );
  });

  it('adds no mark when disabled and never lowers Full', () => {
    expect(strangerMarkForEntries(false, authors, [{ authorId: teammate.id }], isOwner)).toEqual(
      {}
    );
    expect(levelFor()).toEqual({ asks: 'never', reach: 'everything' });
    expect(levelFor(true)).toEqual({ asks: 'never', reach: 'everything', outsider: true });
  });
});
