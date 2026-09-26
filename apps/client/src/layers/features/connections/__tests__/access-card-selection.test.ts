import { describe, expect, it } from 'vitest';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  cardGrantChanges,
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
  it('starts on read-write only when every preset holder already has it', () => {
    expect(initialCardLevel([])).toBe('read');
    expect(initialCardLevel(['read-write', 'custom'])).toBe('read-write');
    expect(initialCardLevel(['read-write', 'read'])).toBe('read');
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

describe('cardGrantChanges', () => {
  it('gives a newly picked agent the level without touching agents already on a preset', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'] }]);
    expect(cardGrantChanges(snapshot, new Set(['ada', 'bo']), 'read-write', false)).toEqual([
      { agentId: 'bo', operationRevisionIds: ['read', 'send'] },
    ]);
  });

  it('moves every picked preset holder once the level is changed, never adding sensitive actions', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'] }]);
    expect(cardGrantChanges(snapshot, new Set(['ada', 'bo']), 'read-write', true)).toEqual([
      { agentId: 'ada', operationRevisionIds: ['read', 'send'] },
      { agentId: 'bo', operationRevisionIds: ['read', 'send'] },
    ]);
  });

  it('keeps exact per-action access but revokes it when the agent is unpicked', () => {
    const snapshot = preview([
      { agentId: 'ada', operationRevisionIds: ['read', 'delete'] },
      { agentId: 'bo', operationRevisionIds: ['read'] },
    ]);
    expect(cardGrantChanges(snapshot, new Set(['ada', 'bo']), 'read-write', true)).toEqual([
      { agentId: 'bo', operationRevisionIds: ['read', 'send'] },
    ]);
    expect(cardGrantChanges(snapshot, new Set(['bo']), 'read', false)).toEqual([
      { agentId: 'ada', operationRevisionIds: [] },
    ]);
  });

  it('writes nothing when the decision matches what the server already holds', () => {
    const snapshot = preview([{ agentId: 'ada', operationRevisionIds: ['read'] }]);
    expect(cardGrantChanges(snapshot, new Set(['ada']), 'read', true)).toEqual([]);
  });
});
