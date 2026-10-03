/**
 * Who said yes is kept with the yes and handed back when it is spent
 * (DOR-2678), so a change only the owner of this DorkOS may make can be held
 * to the owner's yes rather than any signed-in account's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { ApprovalService } from '../approval-service.js';
import { eventFanOut } from '../../event-fan-out.js';

const binding = { capabilityId: 'operator.config_patch', inputHash: 'exact-binding-hash' };
let db: Db;
let service: ApprovalService;

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  service = new ApprovalService(db);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.$client.close();
});

describe('who said yes', () => {
  it('hands back the signed-in account that granted it', () => {
    const ticket = service.request({ ...binding, summary: 'Change a setting.' });
    service.grant(ticket.approvalId, 'user_owner');
    expect(service.consume(ticket.token, binding)).toMatchObject({
      outcome: 'granted',
      decidedByUserId: 'user_owner',
    });
  });

  it('says nothing about who when nobody was signed in', () => {
    const ticket = service.request({ ...binding, summary: 'Change a setting.' });
    service.grant(ticket.approvalId);
    const result = service.consume(ticket.token, binding);
    expect(result.outcome).toBe('granted');
    expect(result).not.toHaveProperty('decidedByUserId');
  });
});
