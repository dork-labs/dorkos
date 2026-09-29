/**
 * What `known_projects` enforces on its own (spec `flow-multiproject` §6.1):
 * one row per root, one project per name, and only the two sources the
 * registry knows. Name stability (a later clash never renames the first
 * project) is the registry's, proved in
 * `apps/server/src/services/projects/__tests__/project-registry.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { knownProjectReporters, knownProjects } from '../schema/projects.js';

const NOW = '2026-09-28T09:00:00.000Z';

function row(overrides: Partial<typeof knownProjects.$inferInsert> = {}) {
  return {
    root: '/Users/kai/dev/dorkos',
    name: 'dorkos',
    originRepo: 'dork-labs/dorkos',
    source: 'seen' as const,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

describe('known_projects', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('stores a project and reads it back', () => {
    db.insert(knownProjects).values(row()).run();
    expect(db.select().from(knownProjects).all()).toEqual([row()]);
  });

  it('refuses a second row for the same root', () => {
    db.insert(knownProjects).values(row()).run();
    expect(() =>
      db
        .insert(knownProjects)
        .values(row({ name: 'dorkos~dev' }))
        .run()
    ).toThrow(/UNIQUE/i);
  });

  it('refuses a second project with the same name', () => {
    db.insert(knownProjects).values(row()).run();
    expect(() =>
      db
        .insert(knownProjects)
        .values(row({ root: '/Users/kai/work/dorkos' }))
        .run()
    ).toThrow(/UNIQUE/i);
  });

  it('refuses a source outside seen | reported', () => {
    expect(() =>
      db
        .insert(knownProjects)
        .values(row({ source: 'guessed' as 'seen' }))
        .run()
    ).toThrow(/CHECK/i);
  });

  it('keeps every extension that named a project, once each, and drops them with it', () => {
    db.insert(knownProjects)
      .values(row({ source: 'reported', originRepo: null }))
      .run();
    const reporter = (extensionId: string, kind: 'report' | 'resolve' = 'report') => ({
      root: '/Users/kai/dev/dorkos',
      extensionId,
      kind,
      reportedAt: NOW,
    });
    db.insert(knownProjectReporters).values(reporter('flow')).run();
    db.insert(knownProjectReporters).values(reporter('hello', 'resolve')).run();
    expect(() => db.insert(knownProjectReporters).values(reporter('flow')).run()).toThrow(
      /UNIQUE|PRIMARY/i
    );
    expect(() =>
      db
        .insert(knownProjectReporters)
        .values(reporter('other', 'guessed' as 'report'))
        .run()
    ).toThrow(/CHECK/i);
    expect(db.select().from(knownProjectReporters).all()).toHaveLength(2);

    db.delete(knownProjects).run();
    expect(db.select().from(knownProjectReporters).all()).toEqual([]);
  });
});
