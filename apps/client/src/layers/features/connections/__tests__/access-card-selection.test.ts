import { describe, expect, it } from 'vitest';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
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
  const { candidates } = preview([]);
  it('reads exact presets and calls anything else custom', () => {
    expect(heldAccess(candidates, [])).toBe('none');
    expect(heldAccess(candidates, ['read'])).toBe('read');
    expect(heldAccess(candidates, ['send', 'read'])).toBe('read-write');
    expect(heldAccess(candidates, ['read', 'send', 'delete'])).toBe('custom');
    expect(heldAccess(candidates, ['send'])).toBe('custom');
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
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'] }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: 'read-write',
        levelTouched: false,
      }).changes
    ).toEqual([{ agentId: 'bo', operationRevisionIds: ['read', 'send'] }]);
  });

  it('moves every picked preset holder once a level is picked, never adding sensitive actions', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'] }]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: 'read-write',
        levelTouched: true,
      }).changes
    ).toEqual([
      { agentId: 'ada', operationRevisionIds: ['read', 'send'] },
      { agentId: 'bo', operationRevisionIds: ['read', 'send'] },
    ]);
  });

  it('keeps exact per-action access, but names and revokes an unpicked agent', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'delete'] },
      { agentId: 'bo', operationRevisionIds: ['read'] },
    ]);
    expect(
      cardDecision(snapshot, {
        scope: ALL,
        picked: new Set(['ada', 'bo']),
        level: 'read-write',
        levelTouched: true,
      }).changes
    ).toEqual([{ agentId: 'bo', operationRevisionIds: ['read', 'send'] }]);
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
      { agentId: 'cy', operationRevisionIds: ['read', 'send'] },
    ]);
    expect(
      cardDecision(snapshot, {
        scope: ['bo'],
        picked: new Set(['bo']),
        level: 'read',
        levelTouched: true,
      })
    ).toEqual({
      changes: [{ agentId: 'bo', operationRevisionIds: ['read'] }],
      removedAgentIds: [],
      downgradedAgentIds: [],
      needsLevel: false,
    });
  });

  it('changes nobody on a mixed switch and asks for a level before adding someone', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'send'] },
      { agentId: 'bo', operationRevisionIds: ['read'] },
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
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read', 'send'] }]);
    const choice = {
      scope: ALL,
      picked: new Set(['ada']),
      level: 'read' as const,
      levelTouched: true,
    };
    expect(cardDecision(snapshot, choice)).toEqual({
      changes: [{ agentId: 'ada', operationRevisionIds: ['read'] }],
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
      everyAgent: { operationRevisionIds: ['read'] },
      needsLevel: false,
    });
    expect(
      everyAgentDecision(off, { who: 'every', level: 'read-write', levelTouched: true })
    ).toEqual({ everyAgent: { operationRevisionIds: ['read', 'send'] }, needsLevel: false });
    const reading = withEvery({ available: true, operationRevisionIds: ['read'] });
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
      everyAgentDecision(withEvery({ available: true, operationRevisionIds: ['read'] }), {
        who: 'picked',
        level: 'read',
        levelTouched: false,
      })
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
      everyAgent: { operationRevisionIds: ['read'] },
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
    const reading = withEvery({ available: true, operationRevisionIds: ['read'] });
    expect(initialEveryAgentLevel(reading)).toBe('read');
    expect(everyAgentCanWrite(reading, null)).toBe(false);
    expect(initialEveryAgentLevel(off)).toBe('read');
    expect(
      initialEveryAgentLevel(withEvery({ available: true, operationRevisionIds: ['read', 'send'] }))
    ).toBe('read-write');
  });
});
