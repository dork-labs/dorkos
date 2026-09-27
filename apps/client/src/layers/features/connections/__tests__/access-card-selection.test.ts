import { describe, expect, it } from 'vitest';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  cardDecision,
  heldAccess,
  initialCardLevel,
  rankAgents,
} from '../lib/access-card-selection';

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
