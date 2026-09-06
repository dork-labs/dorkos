import { describe, expect, it } from 'vitest';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  changedGrantSelections,
  revisionIdsForAccessLevel,
  selectionsFromPreview,
} from '../lib/reconciliation-selection';

const PREVIEW: ConnectorReconciliationPreview = {
  previewId: 'preview-1',
  connection: {
    connectionId: 'connection-1' as never,
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    custody: 'managed',
    reconciliationStatus: 'ready',
  },
  candidates: [
    {
      operationRevisionId: 'read-v1',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.list',
      toolkitVersion: '2026-08-01',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'write-v2',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.send',
      toolkitVersion: '2026-09-01',
      capabilityClassification: 'write',
      retryPolicy: 'provider_idempotency_key',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'delete-v1',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.delete',
      toolkitVersion: '2026-09-01',
      capabilityClassification: 'destructive',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'legacy-v1',
      toolkit: 'gmail',
      operationSlug: 'gmail.legacy.read',
      toolkitVersion: '2025-01-01',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: {},
      supported: false,
    },
  ],
  agents: [
    { agentId: 'agent-a', displayName: 'Ada' },
    { agentId: 'agent-b', displayName: 'Bo' },
  ],
  currentGrants: [{ agentId: 'agent-a', operationRevisionIds: ['legacy-v1', 'read-v1'] }],
  catalogComplete: true,
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2026-09-06T01:00:00.000Z',
};

describe('reconciliation selection', () => {
  it('preserves exact current revisions and leaves every newly discovered revision off', () => {
    expect(selectionsFromPreview(PREVIEW)).toEqual({
      'agent-a': ['legacy-v1', 'read-v1'],
      'agent-b': [],
    });
  });

  it('omits unchanged agents while retaining an explicit empty replacement', () => {
    expect(
      changedGrantSelections(PREVIEW, {
        'agent-a': [],
        'agent-b': [],
      })
    ).toEqual([{ agentId: 'agent-a', operationRevisionIds: [] }]);
  });

  it('keeps destructive and unsupported revisions out of quick access levels', () => {
    expect(revisionIdsForAccessLevel(PREVIEW.candidates, 'read')).toEqual(['read-v1']);
    expect(revisionIdsForAccessLevel(PREVIEW.candidates, 'read-write')).toEqual([
      'read-v1',
      'write-v2',
    ]);
  });
});
