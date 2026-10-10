import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { runWithAuditActor } from '../../audit/audit-context.js';
import {
  ReportsToChain,
  createReportsToChain,
  creatorFromActor,
  currentCreatorAccountId,
  resetRecordedChainCycles,
  type ReportsToAgent,
} from '../reports-to.js';

const OWNER = 'acct-owner';

/** A chain over a hand-built set of agents, with one person: the owner. */
function chainOver(agents: ReportsToAgent[]): ReportsToChain {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return new ReportsToChain({
    getAgent: (id) => byId.get(id),
    ownerAccountId: () => OWNER,
    personAccountId: (id) => (id === OWNER || id === 'install:1' ? OWNER : null),
  });
}

let db: Db;

beforeEach(() => {
  db = createTestDb();
  resetRecordedChainCycles();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({
      db,
      installId: '1',
      readOwnerAccount: () => ({ id: OWNER, name: 'Dorian' }),
    }),
  });
});

afterEach(() => resetAuditTrail());

/** The audit rows with this action. */
function rowsFor(action: string) {
  return db
    .select()
    .from(auditEvents)
    .all()
    .filter((row) => row.action === action);
}

describe('resolveManager', () => {
  it('falls back to the owner when nothing is set', () => {
    const chain = chainOver([{ id: 'A' }]);
    expect(chain.resolveManager('A')).toEqual({
      kind: 'person',
      accountId: OWNER,
      source: 'owner',
    });
  });

  it('reports to its creator when reportsTo is unset', () => {
    const chain = chainOver([{ id: 'A' }, { id: 'B', createdBy: 'A' }]);
    expect(chain.resolveManager('B')).toEqual({
      kind: 'agent',
      accountId: 'A',
      source: 'createdBy',
    });
  });

  it('prefers reportsTo over the creator', () => {
    const chain = chainOver([
      { id: 'A' },
      { id: 'C' },
      { id: 'B', createdBy: 'A', reportsTo: 'C' },
    ]);
    expect(chain.resolveManager('B')).toMatchObject({ accountId: 'C', source: 'reportsTo' });
  });

  it('skips a manager that no longer exists, then a creator that no longer exists', () => {
    const chain = chainOver([{ id: 'B', reportsTo: 'GONE', createdBy: 'ALSO-GONE' }]);
    expect(chain.resolveManager('B')).toMatchObject({ kind: 'person', source: 'owner' });
    const viaCreator = chainOver([{ id: 'A' }, { id: 'B', reportsTo: 'GONE', createdBy: 'A' }]);
    expect(viaCreator.resolveManager('B')).toMatchObject({ accountId: 'A', source: 'createdBy' });
  });

  it('reads the owner’s install-era id as the owner', () => {
    const chain = chainOver([{ id: 'B', createdBy: 'install:1' }]);
    expect(chain.resolveManager('B')).toEqual({
      kind: 'person',
      accountId: OWNER,
      source: 'createdBy',
    });
  });

  it('reads an agent naming itself as unset', () => {
    const chain = chainOver([{ id: 'A', reportsTo: 'A' }]);
    expect(chain.resolveManager('A')).toMatchObject({ source: 'owner' });
  });
});

describe('resolveChainPerson', () => {
  it('walks up through agents to the first person', () => {
    const chain = chainOver([
      { id: 'A', reportsTo: OWNER },
      { id: 'B', createdBy: 'A' },
      { id: 'C', reportsTo: 'B' },
    ]);
    expect(chain.resolveChainPerson('C')).toEqual({
      kind: 'person',
      accountId: OWNER,
      source: 'reportsTo',
    });
  });

  it('stops a hand-made loop at the owner and records it once', () => {
    const chain = chainOver([
      { id: 'A', name: 'Atlas', reportsTo: 'B' },
      { id: 'B', reportsTo: 'A' },
    ]);
    expect(chain.resolveChainPerson('A')).toMatchObject({ kind: 'person', accountId: OWNER });
    expect(chain.resolveChainPerson('A')).toMatchObject({ accountId: OWNER });
    expect(chain.resolveChainPerson('B')).toMatchObject({ accountId: OWNER });

    const rows = rowsFor('heartbeat.chain_cycle');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetId).toBe('A');
    expect(rows[0]?.visibility).toBe('space');
  });
});

describe('wouldCreateCycle', () => {
  it('refuses an agent reporting to itself', () => {
    expect(chainOver([{ id: 'A' }]).wouldCreateCycle('A', 'A')).toBe(true);
  });

  it('refuses a manager that already reports, directly or not, to the agent', () => {
    const chain = chainOver([
      { id: 'A' },
      { id: 'B', reportsTo: 'A' },
      { id: 'C', reportsTo: 'B' },
    ]);
    expect(chain.wouldCreateCycle('A', 'B')).toBe(true);
    expect(chain.wouldCreateCycle('A', 'C')).toBe(true);
  });

  it('counts the creator default as part of the chain', () => {
    // B reports to A by default (A created it), so A cannot report to B.
    const chain = chainOver([{ id: 'A' }, { id: 'B', createdBy: 'A' }]);
    expect(chain.wouldCreateCycle('A', 'B')).toBe(true);
  });

  it('allows a person, a clear, and an unrelated agent', () => {
    const chain = chainOver([{ id: 'A' }, { id: 'B', reportsTo: 'A' }, { id: 'C' }]);
    expect(chain.wouldCreateCycle('A', OWNER)).toBe(false);
    expect(chain.wouldCreateCycle('A', null)).toBe(false);
    expect(chain.wouldCreateCycle('B', 'C')).toBe(false);
  });

  it('does not blame this write for a loop elsewhere', () => {
    const chain = chainOver([
      { id: 'X', reportsTo: 'Y' },
      { id: 'Y', reportsTo: 'X' },
      { id: 'A' },
    ]);
    expect(chain.wouldCreateCycle('A', 'X')).toBe(false);
  });
});

describe('names', () => {
  it('knows agents and the owner, and nobody else', () => {
    const chain = chainOver([{ id: 'A' }]);
    expect(chain.names('A')).toBe(true);
    expect(chain.names(OWNER)).toBe(true);
    expect(chain.names('stranger')).toBe(false);
  });
});

describe('createReportsToChain', () => {
  it('reads agents from the mesh and the owner from the audit trail', () => {
    const chain = createReportsToChain({
      get: (id: string) =>
        id === 'B'
          ? ({ id: 'B', name: 'b', createdBy: 'install:1' } as ReturnType<
              Parameters<typeof createReportsToChain>[0]['get']
            >)
          : undefined,
    });
    expect(chain.resolveManager('B')).toEqual({
      kind: 'person',
      accountId: OWNER,
      source: 'createdBy',
    });
  });
});

describe('creator attribution', () => {
  it('names the person or agent of the current scope, and nobody else', () => {
    expect(creatorFromActor({ accountId: OWNER, kind: 'person', name: 'Dorian' })).toBe(OWNER);
    expect(creatorFromActor({ accountId: '01AGENT', kind: 'agent', name: 'Atlas' })).toBe(
      '01AGENT'
    );
    expect(creatorFromActor({ accountId: 'unregistered:ab', kind: 'agent', name: 'x' })).toBeNull();
    expect(creatorFromActor({ accountId: 'system', kind: 'system', name: 'DorkOS' })).toBeNull();
    expect(creatorFromActor(undefined)).toBeNull();
  });

  it('reads the current audit scope', () => {
    expect(currentCreatorAccountId()).toBeNull();
    const inScope = runWithAuditActor(
      { actor: { accountId: '01AGENT', kind: 'agent', name: 'Atlas' }, surface: 'mcp' },
      () => currentCreatorAccountId()
    );
    expect(inScope).toBe('01AGENT');
  });
});
