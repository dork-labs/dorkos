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

describe('deriveWaitingItems — what extensions ask (spec flow-multiproject §7.5)', () => {
  it('adds one extension-decision item per open decision, after everything else', () => {
    const decision = {
      id: '01J0000000000000000000000D',
      extensionId: 'flow',
      extensionName: 'Flow',
      key: 'ship',
      title: 'Ship it?',
      why: 'It is ready.',
      detail: null,
      project: null,
      projectLabel: null,
      since: null,
      actions: { kind: 'word' as const, label: 'Open' },
      link: null,
      raisedAt: '2026-09-29T09:00:00.000Z',
      needsYou: false,
      watch: null,
      revision: 0,
    };
    const items = deriveWaitingItems({
      approvals: [],
      asks: [],
      schedules: [],
      extensionApprovals: [FLOW],
      extensionDecisions: [decision],
    });
    expect(items.map((item) => item.kind)).toEqual(['extension-approval', 'extension-decision']);
    expect(items[1].id).toBe('extension-decision:01J0000000000000000000000D');
  });
});
