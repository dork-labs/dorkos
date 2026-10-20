/**
 * A handle that reads as somebody else's is refused (DOR-3156): case-folded,
 * then skeletoned by Unicode TR39's own table. Driven through the real registry
 * against a real SQLite file, like the rest of the handle rules.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { agents, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { AuthorRegistry } from '../../author-registry.js';
import { ensureHandles } from '../ensure-handles.js';
import { CONFUSABLE_PROTOTYPES, CONFUSABLES_VERSION, handleSkeleton } from '../handle-skeleton.js';

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/** Register an agent in the mesh cache, the way the reconciler would. */
function registerAgent(db: Db, id: string, projectPath: string, name: string): void {
  db.insert(agents)
    .values({
      id,
      name,
      displayName: name,
      projectPath,
      runtime: 'claude-code',
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

describe('handleSkeleton', () => {
  it('carries exactly the TR39 rows a handle can spell, from a pinned version', () => {
    // The rows `scripts/handle-confusables.ts` prints for confusables.txt 18.0.0.
    // A row added by hand would be a judgment the standard did not make.
    expect(CONFUSABLES_VERSION).toBe('18.0.0');
    expect(CONFUSABLE_PROTOTYPES).toEqual({ '0': 'O', '1': 'l', m: 'rn' });
  });

  it.each([
    ['d0rian', 'dorian'],
    ['rnia', 'mia'],
    ['ana1', 'anal'],
    ['D0RIAN', 'dorian'],
  ])('reads %s as %s', (a, b) => {
    expect(handleSkeleton(a)).toBe(handleSkeleton(b));
  });

  it.each([
    ['ana', 'bo'],
    ['ana', 'ana-pm'],
    ['dorian', 'darian'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(handleSkeleton(a)).not.toBe(handleSkeleton(b));
  });
});

describe('claiming a look-alike handle', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    ensureHandles(db, registry);
  });

  it('refuses an agent a handle that reads as a person’s, and names whose', () => {
    const person = registry.localHuman();
    registry.setHandle(person.id, 'dorian');
    registerAgent(db, 'ULID_ANA', ANA_PATH, 'ana');
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');

    expect(() => registry.setHandle(ana.id, 'd0rian')).toThrow(
      expect.objectContaining({
        code: 'HANDLE_LOOKALIKE',
        message: '@d0rian looks too much like @dorian. Pick a different one.',
      })
    );
    expect(registry.getById(ana.id)?.handle).toBe('ana');
  });

  it('refuses a person a handle that reads as an agent’s', () => {
    registerAgent(db, 'ULID_MIA', ANA_PATH, 'mia');
    registry.resolveAgent(ANA_PATH, 'Mia');
    const person = registry.localHuman();

    expect(() => registry.setHandle(person.id, 'rnia')).toThrow(
      expect.objectContaining({ code: 'HANDLE_LOOKALIKE' })
    );
  });

  it('refuses a look-alike of a released handle and of a reserved word', () => {
    registerAgent(db, 'ULID_ANA', ANA_PATH, 'ana');
    registerAgent(db, 'ULID_BO', BO_PATH, 'bo');
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const bo = registry.resolveAgent(BO_PATH, 'Bo');
    registry.setHandle(ana.id, 'ana-pm');
    registry.setHandle(ana.id, 'ana-lead');

    for (const wanted of ['ana-prn', 'd0rk0s', 'r00rn']) {
      expect(() => registry.setHandle(bo.id, wanted), wanted).toThrow(
        expect.objectContaining({ code: 'HANDLE_LOOKALIKE' })
      );
    }
  });

  it('lets an author take a look-alike of its own handle', () => {
    const person = registry.localHuman();
    registry.setHandle(person.id, 'dorian');

    expect(registry.setHandle(person.id, 'd0rian').handle).toBe('d0rian');
    // And back again: the released `dorian` is its own lineage's.
    expect(registry.setHandle(person.id, 'dorian').handle).toBe('dorian');
  });

  it('still refuses a Cyrillic look-alike as a spelling, before any skeleton', () => {
    const person = registry.localHuman();
    // `о` here is U+043E CYRILLIC SMALL LETTER O.
    expect(() => registry.setHandle(person.id, 'dоrian')).toThrow(
      expect.objectContaining({ code: 'INVALID_HANDLE' })
    );
  });
});
