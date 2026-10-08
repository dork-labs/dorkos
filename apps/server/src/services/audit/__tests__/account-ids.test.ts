/**
 * Stable account ids (spec `audit-trail` §3.2): an agent is its mesh id, never
 * its folder; the owner has an id even with login off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { AccountIds } from '../account-ids.js';

const AGENT_PATH = '/projects/scout';

function seedAgent(db: Db): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: '01SCOUTAGENTULID0000000000',
      name: 'scout',
      runtime: 'claude-code',
      projectPath: AGENT_PATH,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('AccountIds', () => {
  let db: Db;
  let owner: { id: string; name: string } | null;
  let ids: AccountIds;

  beforeEach(() => {
    db = createTestDb();
    owner = null;
    ids = new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => owner });
  });

  it('names a registered agent by its mesh id, not its path', () => {
    seedAgent(db);
    expect(ids.agent(AGENT_PATH, 'Scout')).toEqual({
      accountId: '01SCOUTAGENTULID0000000000',
      kind: 'agent',
      name: 'Scout',
    });
  });

  it('takes a non-path reference to be a mesh id already', () => {
    expect(ids.agentAccountId('01SCOUTAGENTULID0000000000')).toBe('01SCOUTAGENTULID0000000000');
  });

  it('names an unregistered agent by a hash of its path, never the path itself', () => {
    const id = ids.agentAccountId(AGENT_PATH);
    expect(id).toMatch(/^unregistered:[0-9a-f]{16}$/);
    expect(id).not.toContain('scout');
    expect(ids.agentAccountId(AGENT_PATH)).toBe(id);
  });

  it('gives the owner the install id while nobody has an account', () => {
    expect(ids.owner()).toEqual({ accountId: 'install:inst-1', kind: 'person', name: 'Owner' });
  });

  it('gives the owner their account id once they have one', () => {
    owner = { id: 'user-abc', name: 'Dorian' };
    expect(ids.owner()).toEqual({ accountId: 'user-abc', kind: 'person', name: 'Dorian' });
  });
});
