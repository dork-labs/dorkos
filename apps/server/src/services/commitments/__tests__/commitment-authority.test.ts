/**
 * The power a commitment carries (DOR-3088): what each new row is written with, how stored
 * authority and marks are read, and that a value nobody can read falls to the stricter level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { commitments, eq, type Db } from '@dorkos/db';
import { CommitmentStore } from '../commitment-store.js';
import { CommitmentError, CommitmentService, PERSON_ASSIGNER } from '../commitment-service.js';
import {
  readAuthority,
  readAuthorityMarks,
  UNREADABLE_AUTHORITY,
  writeAuthority,
  writeAuthorityMarks,
  type WritableCommitmentAuthority,
} from '../commitment-authority.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

describe('commitment authority', () => {
  describe('reading', () => {
    it('reads each named authority and a recorded level', () => {
      expect(readAuthority('legacy')).toEqual({ kind: 'legacy' });
      expect(readAuthority('self')).toEqual({ kind: 'self' });
      expect(readAuthority('person')).toEqual({ kind: 'person' });
      expect(readAuthority('runtime-default')).toEqual({ kind: 'runtime-default' });
      expect(readAuthority('{"asks":"when-risky","reach":"workspace"}')).toEqual({
        kind: 'level',
        level: { asks: 'when-risky', reach: 'workspace' },
      });
      expect(readAuthority('{"asks":"never","reach":"everything","auto":true}')).toEqual({
        kind: 'level',
        level: { asks: 'never', reach: 'everything', auto: true },
      });
    });

    it.each([
      ['missing', null],
      ['empty', ''],
      ['an unknown name', 'admin'],
      ['unreadable', '{nope'],
      ['a level with no reach', '{"asks":"never"}'],
      ['a level reaching further than any mode', '{"asks":"never","reach":"root"}'],
      ['not an object', '[]'],
    ])('reads %s authority as the stranger bound, never as permission', (_label, stored) => {
      expect(readAuthority(stored)).toEqual(UNREADABLE_AUTHORITY);
      expect(UNREADABLE_AUTHORITY).toEqual({ kind: 'runtime-default' });
    });

    it('reads marks, and reads missing or unreadable marks as the outsider mark', () => {
      expect(readAuthorityMarks('{}')).toEqual({});
      expect(readAuthorityMarks('{"outsider":true}')).toEqual({ outsider: true });
      expect(readAuthorityMarks('{"teammate":[{"roomId":"r","authorId":"a"}]}')).toEqual({
        teammate: [{ roomId: 'r', authorId: 'a' }],
      });
      expect(readAuthorityMarks(null)).toEqual({ outsider: true });
      expect(readAuthorityMarks('')).toEqual({ outsider: true });
      expect(readAuthorityMarks('{nope')).toEqual({ outsider: true });
    });
  });

  describe('writing', () => {
    it('never writes legacy', () => {
      expect(() =>
        writeAuthority({ kind: 'legacy' } as unknown as WritableCommitmentAuthority)
      ).toThrow(/legacy/);
    });

    it('round-trips every writable authority and marks', () => {
      const all: WritableCommitmentAuthority[] = [
        { kind: 'self' },
        { kind: 'person' },
        { kind: 'runtime-default' },
        { kind: 'level', level: { asks: 'always', reach: 'read' } },
      ];
      for (const authority of all)
        expect(readAuthority(writeAuthority(authority))).toEqual(authority);
      expect(writeAuthorityMarks({})).toBe('{}');
      expect(readAuthorityMarks(writeAuthorityMarks({ outsider: true }))).toEqual({
        outsider: true,
      });
    });
  });

  describe('new rows', () => {
    let db: Db;
    let service: CommitmentService;

    beforeEach(() => {
      db = createTestDb();
      service = new CommitmentService({ store: new CommitmentStore(db) });
    });

    afterEach(() => service.stop());

    function stored(id: string) {
      return db.select().from(commitments).where(eq(commitments.id, id)).get()!;
    }

    it("writes an agent's own promise as self, assigned by itself, carrying its turn's marks", () => {
      const made = service.create('agent-a', { what: 'Ship it', originMarks: { outsider: true } });
      expect(stored(made.id)).toMatchObject({
        agentId: 'agent-a',
        ownerAccount: null,
        assignedByKind: 'agent',
        assignedBy: 'agent-a',
        authority: 'self',
        authorityMarks: '{"outsider":true}',
        chainDepth: 0,
        chainAgents: '[]',
        titleFromSource: false,
      });
    });

    it("writes a person's as person, with no marks", () => {
      const made = service.create('agent-a', { what: 'Ship it' }, { kind: 'person' });
      expect(stored(made.id)).toMatchObject({
        assignedByKind: 'person',
        assignedBy: PERSON_ASSIGNER,
        authority: 'person',
        authorityMarks: '{}',
      });
    });

    it('never writes legacy, whoever makes it', () => {
      service.create('agent-a', { what: 'One' });
      service.create('agent-a', { what: 'Two' }, { kind: 'person' });
      const authorities = db.select({ a: commitments.authority }).from(commitments).all();
      expect(authorities.map((r) => r.a).sort()).toEqual(['person', 'self']);
    });

    it('refuses an agent recording a promise for another agent', () => {
      expect(() =>
        service.create('agent-a', { what: 'Yours now' }, { kind: 'agent', agentId: 'agent-b' })
      ).toThrow(CommitmentError);
    });

    it('never returns a to-do a person owns to the promise readers', () => {
      db.insert(commitments)
        .values({
          id: 'person-owned',
          agentId: null,
          ownerAccount: 'owner',
          what: 'Call the bank',
          state: 'open',
          createdAt: '2026-11-02T09:00:00.000Z',
          dueAt: '2026-11-03T09:00:00.000Z',
          assignedByKind: 'person',
          assignedBy: 'owner',
          authority: 'person',
          authorityMarks: '{}',
          chainDepth: 0,
          chainAgents: '[]',
          titleFromSource: false,
        })
        .run();
      expect(service.get('person-owned')).toBeUndefined();
      expect(service.list()).toEqual([]);
      expect(new CommitmentStore(db).openWithDueDate()).toEqual([]);
    });
  });
});
