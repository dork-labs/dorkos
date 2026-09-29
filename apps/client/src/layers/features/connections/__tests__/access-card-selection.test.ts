import { describe, expect, it } from 'vitest';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  agentHeldAccess,
  cardDecision,
  everyAgentHoldsHighRisk,
  everyAgentCanWrite,
  everyAgentDecision,
  initialEveryAgentLevel,
  heldAccess,
  initialCardLevel,
  initialWhoCanUse,
  rankAgents,
} from '../lib/access-card-selection';
import { everyAgentWriteWarning } from '../ui/access/access-labels';

function candidate(id: string, classification: 'read' | 'write' | 'destructive', supported = true) {
  return {
    operationRevisionId: id,
    toolkit: 'gmail',
    operationSlug: `gmail.${id}`,
    toolkitVersion: '1',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported,
  };
}

function preview(
  currentGrants: ConnectorReconciliationPreview['currentGrants'],
  agents = ['ada', 'bo', 'cy'].map((id) => ({ agentId: id, displayName: id.toUpperCase() }))
): ConnectorReconciliationPreview {
  return {
    previewId: 'p',
    connection: {
      connectionId: 'c' as never,
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      candidate('read', 'read'),
      candidate('old-read', 'read', false),
      candidate('send', 'write'),
      candidate('delete', 'destructive'),
    ],
    agents,
    currentGrants,
    everyAgent: { available: true, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    expiresAt: '2099-09-06T00:00:00.000Z',
  };
}

describe('heldAccess', () => {
  it('reads the level the owner chose, and calls a grant without one exact actions', () => {
    expect(heldAccess(undefined)).toBe('none');
    expect(heldAccess({ operationRevisionIds: [] })).toBe('none');
    expect(heldAccess({ operationRevisionIds: ['read'], level: 'read' })).toBe('read');
    expect(heldAccess({ operationRevisionIds: ['send', 'read'], level: 'read-write' })).toBe(
      'read-write'
    );
    expect(heldAccess({ operationRevisionIds: ['read', 'send', 'delete'] })).toBe('custom');
    // Exactly what Read covers, but picked action by action: exact actions,
    // never guessed into a level.
    expect(heldAccess({ operationRevisionIds: ['read'] })).toBe('custom');
  });

  it('keeps saying Read after the app changes its actions (DOR-2506)', () => {
    // The set no longer matches today's Read actions; the level is still Read.
    expect(heldAccess({ operationRevisionIds: ['old-read'], level: 'read' })).toBe('read');
    // A level that holds nothing it can use yet (the service refused it, or
    // has not applied it) is never shown as access the agent has.
    expect(heldAccess({ operationRevisionIds: [], level: 'read-write' })).toBe('none');
  });
});

describe('initialCardLevel', () => {
  it('starts on the shared preset, on Read with none, and mixed when presets differ', () => {
    expect(initialCardLevel([])).toBe('read');
    expect(initialCardLevel(['read-write', 'custom'])).toBe('read-write');
    expect(initialCardLevel(['read-write', 'read'])).toBeNull();
  });
});

describe('rankAgents', () => {
  it('lists agents with access, then suggestions, then system agents, then the rest', () => {
    const agents = ['ada', 'bo', 'cy', 'dorkbot', 'eve'].map((id) => ({
      agentId: id,
      displayName: id,
    }));
    const ranked = rankAgents(
      preview([{ agentId: 'eve', operationRevisionIds: ['read'] }], agents),
      {
        preferredAgentIds: ['cy'],
        systemAgentIds: ['dorkbot'],
      }
    );
    expect(ranked.map((agent) => agent.agentId)).toEqual(['eve', 'cy', 'dorkbot', 'ada', 'bo']);
  });
});

const ALL = ['ada', 'bo', 'cy'];

describe('cardDecision', () => {
  it('gives a newly picked agent the level without touching agents already on a preset', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'], level: 'read' }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: 'read-write',
        levelTouched: false,
      }).changes
    ).toEqual([{ agentId: 'bo', operationRevisionIds: ['read', 'send'], level: 'read-write' }]);
  });

  it('moves every picked preset holder once a level is picked, never adding sensitive actions', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'], level: 'read' }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: 'read-write',
        levelTouched: true,
      }).changes
    ).toEqual([
      { agentId: 'ada', operationRevisionIds: ['read', 'send'], level: 'read-write' },
      { agentId: 'bo', operationRevisionIds: ['read', 'send'], level: 'read-write' },
    ]);
  });

  it('keeps exact per-action access, but names and revokes an unpicked agent', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'delete'] },
      { agentId: 'bo', operationRevisionIds: ['read'], level: 'read' },
    ]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: 'read-write',
        levelTouched: true,
      }).changes
    ).toEqual([{ agentId: 'bo', operationRevisionIds: ['read', 'send'], level: 'read-write' }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['bo']),
        level: 'read',
        levelTouched: false,
      })
    ).toEqual({
      changes: [{ agentId: 'ada', operationRevisionIds: [] }],
      removedAgentIds: ['ada'],
      downgradedAgentIds: [],
      needsLevel: false,
    });
  });

  it('writes only the agents in scope, whatever everyone else holds', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'delete'] },
      { agentId: 'cy', operationRevisionIds: ['read', 'send'], level: 'read-write' },
    ]);
    expect(
      cardDecision(snapshot, {
        scope: ['bo'],
        picked: new Set(['bo']),
        level: 'read',
        levelTouched: true,
      })
    ).toEqual({
      changes: [{ agentId: 'bo', operationRevisionIds: ['read'], level: 'read' }],
      removedAgentIds: [],
      downgradedAgentIds: [],
      needsLevel: false,
    });
  });

  it('changes nobody on a mixed switch and asks for a level before adding someone', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'send'], level: 'read-write' },
      { agentId: 'bo', operationRevisionIds: ['read'], level: 'read' },
    ]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: null,
        levelTouched: false,
      })
    ).toEqual({ changes: [], removedAgentIds: [], downgradedAgentIds: [], needsLevel: false });
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo', 'cy']),
        level: null,
        levelTouched: false,
      })
    ).toEqual({ changes: [], removedAgentIds: [], downgradedAgentIds: [], needsLevel: true });
  });

  it('writes nothing when the decision matches what the server already holds', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'], level: 'read' }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada']),
        level: 'read',
        levelTouched: true,
      }).changes
    ).toEqual([]);
  });

  it('saves Read as the level again after the app changed its actions, not as exact actions', () => {
    // Ada holds Read from before the app added its current read action.
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['old-read'], level: 'read' },
    ]);
    const decision = cardDecision(snapshot, {
      scope: ALL,
      picked: new Set(['ada']),
      level: 'read',
      levelTouched: false,
    });
    // Untouched: nothing is written, and she still reads as Read.
    expect(decision.changes).toEqual([]);
    expect(heldAccess(snapshot.currentGrants[0])).toBe('read');
  });

  it('never turns hand-picked actions into a level, even when they equal one', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'] }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada']),
        level: 'read',
        levelTouched: true,
      }).changes
    ).toEqual([]);
  });

  it('names a downgrade, and never makes one when downgrades are not allowed', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'send'], level: 'read-write' },
    ]);
    const choice = {
      scope: ALL,
      picked: new Set(['ada']),
      level: 'read' as const,
      levelTouched: true,
    };
    expect(cardDecision(snapshot, choice)).toEqual({
      changes: [{ agentId: 'ada', operationRevisionIds: ['read'], level: 'read' }],
      removedAgentIds: [],
      downgradedAgentIds: ['ada'],
      needsLevel: false,
    });
    expect(cardDecision(snapshot, { ...choice, allowDowngrade: false })).toEqual({
      changes: [],
      removedAgentIds: [],
      downgradedAgentIds: [],
      needsLevel: false,
    });
  });
});

describe('everyAgentDecision (DOR-2420)', () => {
  const withEvery = (
    everyAgent: ConnectorReconciliationPreview['everyAgent']
  ): ConnectorReconciliationPreview => ({ ...preview([]), everyAgent });
  const off = withEvery({ available: true, operationRevisionIds: [] });

  it('sends the chosen preset for every agent, and nothing when it already holds it', () => {
    expect(everyAgentDecision(off, { who: 'every', level: 'read', levelTouched: false })).toEqual({
      everyAgent: { operationRevisionIds: ['read'], level: 'read' },
      needsLevel: false,
    });
    expect(
      everyAgentDecision(off, { who: 'every', level: 'read-write', levelTouched: true })
    ).toEqual({
      everyAgent: { operationRevisionIds: ['read', 'send'], level: 'read-write' },
      needsLevel: false,
    });
    const reading = withEvery({ available: true, operationRevisionIds: ['read'], level: 'read' });
    expect(initialWhoCanUse(reading)).toBe('every');
    expect(
      everyAgentDecision(reading, { who: 'every', level: 'read', levelTouched: true })
    ).toEqual({
      needsLevel: false,
    });
  });

  it('stops sharing only when it is shared now, and never writes when unavailable', () => {
    expect(everyAgentDecision(off, { who: 'picked', level: 'read', levelTouched: false })).toEqual({
      needsLevel: false,
    });
    expect(initialWhoCanUse(off)).toBe('picked');
    expect(
      everyAgentDecision(
        withEvery({ available: true, operationRevisionIds: ['read'], level: 'read' }),
        {
          who: 'picked',
          level: 'read',
          levelTouched: false,
        }
      )
    ).toEqual({ everyAgent: { operationRevisionIds: [] }, needsLevel: false });
    expect(
      everyAgentDecision(withEvery({ available: false, operationRevisionIds: [] }), {
        who: 'every',
        level: 'read-write',
        levelTouched: true,
      })
    ).toEqual({ needsLevel: false });
  });

  it('leaves an exact-actions set alone until the level is touched, and asks for a level when mixed', () => {
    const exact = withEvery({ available: true, operationRevisionIds: ['delete'] });
    expect(everyAgentDecision(exact, { who: 'every', level: null, levelTouched: false })).toEqual({
      needsLevel: false,
    });
    // Even with a level on the switch, an untouched exact set is never overwritten.
    expect(everyAgentDecision(exact, { who: 'every', level: 'read', levelTouched: false })).toEqual(
      {
        needsLevel: false,
      }
    );
    expect(everyAgentDecision(exact, { who: 'every', level: 'read', levelTouched: true })).toEqual({
      everyAgent: { operationRevisionIds: ['read'], level: 'read' },
      needsLevel: false,
    });
    expect(everyAgentDecision(off, { who: 'every', level: null, levelTouched: false })).toEqual({
      needsLevel: true,
    });
  });

  it('names what write access lets every agent do, per app', () => {
    expect(everyAgentWriteWarning('gmail', 'Gmail')).toBe(
      'Every agent — including ones you add later — could send email as you.'
    );
    expect(everyAgentWriteWarning('asana', 'Asana')).toBe(
      'Every agent — including ones you add later — could make changes in Asana as you.'
    );
    expect(everyAgentWriteWarning('gmail', 'Gmail', true)).toBe(
      'Every agent — including ones you add later — could send email and take high-risk actions as you.'
    );
    expect(everyAgentWriteWarning('asana', 'Asana', true)).toBe(
      'Every agent — including ones you add later — could make changes in Asana and take high-risk actions as you.'
    );
  });

  it('calls a shared forward a high-risk action, never a delete', () => {
    // The service marks forwarding destructive; nothing here deletes anything.
    const forwardOnly: ConnectorReconciliationPreview = {
      ...preview([]),
      candidates: [
        candidate('read', 'read'),
        candidate('send', 'write'),
        candidate('forward', 'destructive'),
      ],
      everyAgent: { available: true, operationRevisionIds: ['read', 'send', 'forward'] },
    };
    const held = everyAgentHoldsHighRisk(forwardOnly, null);
    expect(held).toBe(true);
    const line = everyAgentWriteWarning('gmail', 'Gmail', held);
    expect(line).toContain('take high-risk actions');
    expect(line).not.toMatch(/delete/iu);
  });

  it('never starts on Read, or hides the warning, while every agent can write or delete', () => {
    const exact = withEvery({ available: true, operationRevisionIds: ['read', 'send', 'delete'] });
    expect(initialEveryAgentLevel(exact)).toBeNull();
    expect(everyAgentCanWrite(exact, null)).toBe(true);
    expect(everyAgentCanWrite(exact, 'read')).toBe(false);
    // Delete is only ever held, never chosen: the card's levels leave it out.
    expect(everyAgentHoldsHighRisk(exact, null)).toBe(true);
    expect(everyAgentHoldsHighRisk(exact, 'read-write')).toBe(false);
    expect(
      everyAgentHoldsHighRisk(
        withEvery({ available: true, operationRevisionIds: ['read', 'send'] }),
        null
      )
    ).toBe(false);
    const reading = withEvery({ available: true, operationRevisionIds: ['read'], level: 'read' });
    expect(initialEveryAgentLevel(reading)).toBe('read');
    // Shared as exact actions that happen to equal Read: never shown as Read.
    expect(
      initialEveryAgentLevel(withEvery({ available: true, operationRevisionIds: ['read'] }))
    ).toBeNull();
    expect(everyAgentCanWrite(reading, null)).toBe(false);
    expect(initialEveryAgentLevel(off)).toBe('read');
    expect(
      initialEveryAgentLevel(
        withEvery({ available: true, operationRevisionIds: ['read', 'send'], level: 'read-write' })
      )
    ).toBe('read-write');
  });
});

describe('a level the service refused (DOR-2506)', () => {
  // The service refused the widening, so the level holds nothing usable.
  const refused = (): ConnectorReconciliationPreview => ({
    ...preview([{ agentId: 'ada', operationRevisionIds: [], level: 'read-write' }]),
    everyAgent: { available: true, operationRevisionIds: [], level: 'read-write' },
  });

  it('never reads as access the agent has, alone or through every agent', () => {
    expect(heldAccess(refused().currentGrants[0])).toBe('none');
    expect(heldAccess(refused().everyAgent)).toBe('none');
    // The chat card's "covered" reads this: nothing is covered.
    expect(agentHeldAccess(refused(), 'ada')).toBe('none');
    expect(agentHeldAccess(refused(), 'bo')).toBe('none');
  });

  it('sends the same level again when the owner picks it again', () => {
    expect(
      everyAgentDecision(refused(), { who: 'every', level: 'read-write', levelTouched: true })
    ).toEqual({
      everyAgent: { operationRevisionIds: ['read', 'send'], level: 'read-write' },
      needsLevel: false,
    });
    expect(
      cardDecision(refused(), {
        scope: ['ada'],
        picked: new Set(['ada']),
        level: 'read-write',
        levelTouched: true,
      }).changes
    ).toEqual([{ agentId: 'ada', operationRevisionIds: ['read', 'send'], level: 'read-write' }]);
  });
});
