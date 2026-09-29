/**
 * An installed extension waiting to be turned on is one item in the Inbox's
 * waiting queue, in the same id vocabulary as every other item (DOR-2517).
 */
import { describe, it, expect } from 'vitest';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { deriveWaitingItems } from '../model/derive-waiting-items';

const FLOW: PendingExtensionApproval = {
  id: 'flow',
  name: 'Flow',
  version: '1.2.0',
  path: '/h/.dork/plugins/flow/.dork/extensions/flow',
  plugin: 'flow',
  sourceLabel: 'flow plugin · dork-labs/marketplace',
  runsInServer: false,
  adds: null,
  since: '2026-09-28T12:00:00.000Z',
  why: 'You installed the flow plugin. It runs as you.',
};

describe('deriveWaitingItems — extensions waiting to be turned on', () => {
  it('adds one extension-approval item per waiting copy', () => {
    const items = deriveWaitingItems({
      approvals: [],
      asks: [],
      schedules: [],
      extensionApprovals: [FLOW, { ...FLOW, id: 'other', path: '/h/other' }],
    });

    expect(items).toEqual([
      { id: `extension:flow:flow:${FLOW.path}:1.2.0`, kind: 'extension-approval' },
      { id: 'extension:other:flow:/h/other:1.2.0', kind: 'extension-approval' },
    ]);
  });

  it('adds nothing when the caller does not pass any', () => {
    expect(deriveWaitingItems({ approvals: [], asks: [], schedules: [] })).toEqual([]);
  });
});
