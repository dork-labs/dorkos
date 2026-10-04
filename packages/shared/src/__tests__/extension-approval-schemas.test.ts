/**
 * The pending-extension list survives a server one version behind (DOR-2685).
 * The client parses the whole response strictly, so a field the older server
 * never sends must not throw: one missing line would empty the whole inbox.
 */
import { describe, it, expect } from 'vitest';
import { PendingExtensionApprovalsResponseSchema } from '../extension-approval-schemas.js';

const OLDER_SERVER_ROW = {
  id: 'flow',
  name: 'Flow',
  version: '1.2.0',
  path: '/home/me/.dork/plugins/flow/.dork/extensions/flow',
  plugin: 'flow',
  sourceLabel: 'flow plugin · dork-labs/marketplace',
  runsInServer: true,
  adds: null,
  since: '2026-09-28T12:00:00.000Z',
  why: 'You installed the flow plugin. It runs as you.',
};

describe('PendingExtensionApprovalsResponseSchema', () => {
  it('reads a row from a server that sends no agent tools or skills as giving none', () => {
    const parsed = PendingExtensionApprovalsResponseSchema.parse({
      approvals: [OLDER_SERVER_ROW],
    });

    expect(parsed.approvals).toHaveLength(1);
    expect(parsed.approvals[0]).toMatchObject({ id: 'flow', agentTools: [], agentSkills: [] });
  });

  it('keeps what a current server sends', () => {
    const parsed = PendingExtensionApprovalsResponseSchema.parse({
      approvals: [
        {
          ...OLDER_SERVER_ROW,
          agentTools: [{ name: 'list_items', title: 'List work items', tier: 'observe' }],
          agentSkills: [{ name: 'triage-board' }],
        },
      ],
    });

    expect(parsed.approvals[0].agentTools).toEqual([
      { name: 'list_items', title: 'List work items', tier: 'observe' },
    ]);
    expect(parsed.approvals[0].agentSkills).toEqual([{ name: 'triage-board' }]);
  });
});
