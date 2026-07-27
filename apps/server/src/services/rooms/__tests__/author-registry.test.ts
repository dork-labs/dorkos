/**
 * The regression test ADR 260726-170126 exists to make impossible: an agent's
 * persisted author id must survive the mesh reconciler rebuilding its row under
 * a fresh manifest ULID.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, authors, eq, type Db } from '@dorkos/db';
import { AuthorRegistry, toAuthorRef } from '../author-registry.js';

const ANA_PATH = '/Users/dorian/agents/ana';

/** Register an agent row the way the mesh registry does, under a given ULID. */
function registerAgent(db: Db, id: string, projectPath: string, name: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id,
      name,
      runtime: 'claude-code',
      projectPath,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('AuthorRegistry', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('mints once and resolves to the same id every time after', () => {
    const first = registry.resolveAgent(ANA_PATH, 'Ana');
    const second = registry.resolveAgent(ANA_PATH, 'Ana');
    const third = registry.resolveAgent(ANA_PATH, 'Ana');

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(db.select().from(authors).all()).toHaveLength(1);
  });

  it('keeps the same author id when the reconciler rebuilds the agent under a new ULID', () => {
    // The state before: an agent registered under one ULID, with an author.
    registerAgent(db, 'ULID_BEFORE_REBUILD', ANA_PATH, 'ana');
    const before = registry.resolveAgent(ANA_PATH, 'Ana');

    // The ADR-0043 reconciler is licensed to delete the derived cache and
    // rebuild it from `agent.json` on disk, re-registering under a fresh ULID.
    db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();
    registerAgent(db, 'ULID_AFTER_REBUILD', ANA_PATH, 'ana');

    const after = registry.resolveAgent(ANA_PATH, 'Ana');

    // The manifest id changed. The author id did not, so every message Ana ever
    // wrote still resolves to her.
    expect(db.select().from(agents).where(eq(agents.projectPath, ANA_PATH)).get()?.id).toBe(
      'ULID_AFTER_REBUILD'
    );
    expect(after.id).toBe(before.id);
    expect(db.select().from(authors).all()).toHaveLength(1);
  });

  it('gives a different agent directory a different author', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const bo = registry.resolveAgent('/Users/dorian/agents/bo', 'Bo');
    expect(bo.id).not.toBe(ana.id);
  });

  it('refreshes the cached display name without moving the id', () => {
    const first = registry.resolveAgent(ANA_PATH, 'Ana');
    const renamed = registry.resolveAgent(ANA_PATH, 'Ana Reyes');

    expect(renamed.id).toBe(first.id);
    expect(renamed.displayName).toBe('Ana Reyes');
    expect(registry.getById(first.id)?.displayName).toBe('Ana Reyes');
  });

  it('keeps human, agent and system in one table without colliding on a shared key', () => {
    const asAgent = registry.resolve({
      kind: 'agent',
      naturalKey: 'system',
      displayName: 'An agent literally called system',
    });
    expect(registry.system().id).not.toBe(asAgent.id);
  });

  it('mints exactly one local human and one system author', () => {
    expect(registry.localHuman().id).toBe(registry.localHuman().id);
    expect(registry.system().id).toBe(registry.system().id);
    expect(db.select().from(authors).all()).toHaveLength(2);
  });

  it('resolves many authors in one read', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const human = registry.localHuman();
    const found = registry.getMany([ana.id, human.id, 'never-minted']);

    expect(found.size).toBe(2);
    expect(found.get(ana.id)?.displayName).toBe('Ana');
  });

  it('keeps the natural key off the shape that reaches a room member', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const ref = toAuthorRef(ana);

    expect(ana.naturalKey).toBe(ANA_PATH);
    expect(JSON.stringify(ref)).not.toContain('/Users/dorian');
    // The projection is closed, not filtered: the assertion is the WHOLE key
    // set, so a field added to `AuthorRecord` cannot ride onto the wire by
    // being spread into the ref and nobody noticing.
    expect(Object.keys(ref).sort()).toEqual(['agentRef', 'displayName', 'id', 'kind']);
  });

  it('gives an agent a handle derived from its path, not the path', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const renamed = registry.resolveAgent(ANA_PATH, 'Ana II');

    // Same path, so the same handle — a rename does not change who this is.
    expect(toAuthorRef(renamed).agentRef).toBe(toAuthorRef(ana).agentRef);
    expect(toAuthorRef(ana).agentRef).not.toContain(ANA_PATH);
    // A human has no agent to point at.
    expect(toAuthorRef(registry.localHuman()).agentRef).toBeUndefined();
  });
});
