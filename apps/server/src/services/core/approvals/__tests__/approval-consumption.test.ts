import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvals, createDb, eq, runMigrations, type Db } from '@dorkos/db';
import { ApprovalService, type ApprovalConsumptionSettlement } from '../approval-service.js';
import { eventFanOut } from '../../event-fan-out.js';

const binding = { capabilityId: 'ui.approve_doc_route', inputHash: 'exact-binding-hash' };
let db: Db;
let service: ApprovalService;
let broadcast: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  service = new ApprovalService(db);
  broadcast = vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.$client.close();
});
function approved() {
  const ticket = service.request({ ...binding, summary: 'Allow this exact document route.' });
  service.grant(ticket.approvalId);
  broadcast.mockClear();
  return ticket;
}
function consumedEvents() {
  return broadcast.mock.calls.filter(
    (call: unknown[]) =>
      call[0] === 'approval_resolved' && (call[1] as { outcome?: string }).outcome === 'consumed'
  );
}
describe('after-commit approval consumption', () => {
  it('refuses a different SQLite connection before participating in another transaction', () => {
    const other = createDb(':memory:');
    try {
      expect(() => service.assertTransactionDatabase(db)).not.toThrow();
      expect(() => service.assertTransactionDatabase(other)).toThrow('same transaction database');
    } finally {
      other.$client.close();
    }
  });
  it('preserves immediate publication for existing callers', () => {
    const ticket = approved();
    expect(service.consume(ticket.token, binding).outcome).toBe('granted');
    expect(broadcast).toHaveBeenCalledWith(
      'approval_resolved',
      expect.objectContaining({ approvalId: ticket.approvalId, outcome: 'consumed' })
    );
    expect(consumedEvents()).toHaveLength(1);
  });
  it('publishes a genuine committed consumption once, refusing early or copied settlements', () => {
    const ticket = approved();
    const settlements: ApprovalConsumptionSettlement[] = [];
    db.transaction(() => {
      expect(
        service.consume(ticket.token, binding, {
          deferSettlement: (proof) => settlements.push(proof),
        }).outcome
      ).toBe('granted');
      expect(service.publishConsumption(settlements[0])).toBe(false);
      expect(broadcast).not.toHaveBeenCalled();
    });
    expect(service.publishConsumption({ ...settlements[0] })).toBe(false);
    expect(service.publishConsumption(settlements[0])).toBe(true);
    expect(service.publishConsumption(settlements[0])).toBe(false);
    expect(consumedEvents()).toHaveLength(1);
  });
  it('refuses a rolled-back consumed row, retains the actual token, and publishes its successful retry once', () => {
    const ticket = approved();
    const discarded: ApprovalConsumptionSettlement[] = [];
    expect(() =>
      db.transaction(() => {
        service.consume(ticket.token, binding, {
          deferSettlement: (proof) => discarded.push(proof),
        });
        throw new Error('storage failure');
      })
    ).toThrow('storage failure');
    expect(service.publishConsumption(discarded[0])).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.consumedAt
    ).toBeNull();
    const committed: ApprovalConsumptionSettlement[] = [];
    db.transaction(() =>
      service.consume(ticket.token, binding, { deferSettlement: (proof) => committed.push(proof) })
    );
    expect(service.publishConsumption(committed[0])).toBe(true);
    expect(consumedEvents()).toHaveLength(1);
  });
  it.each([false, true])(
    'retires a rolled-back proof when frozen-clock retry consumes again (immediate=%s)',
    (immediate) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
      const ticket = approved();
      const old: ApprovalConsumptionSettlement[] = [];
      expect(() =>
        db.transaction(() => {
          service.consume(ticket.token, binding, { deferSettlement: (proof) => old.push(proof) });
          throw new Error('rollback');
        })
      ).toThrow('rollback');
      const current: ApprovalConsumptionSettlement[] = [];
      db.transaction(() =>
        service.consume(
          ticket.token,
          binding,
          immediate ? undefined : { deferSettlement: (proof) => current.push(proof) }
        )
      );
      expect(service.publishConsumption(old[0])).toBe(false);
      if (!immediate) expect(service.publishConsumption(current[0])).toBe(true);
      expect(consumedEvents()).toHaveLength(1);
    }
  );
  it('rechecks the committed binding and refuses evidence changed after consumption', () => {
    const ticket = approved();
    const settlements: ApprovalConsumptionSettlement[] = [];
    db.transaction(() =>
      service.consume(ticket.token, binding, {
        deferSettlement: (proof) => settlements.push(proof),
      })
    );
    db.update(approvals)
      .set({ inputHash: 'different-action' })
      .where(eq(approvals.id, ticket.approvalId))
      .run();
    expect(service.publishConsumption(settlements[0])).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
