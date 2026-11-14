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

  it('reads a row from a server that sends no permissions as unknown, not an error (DOR-2686)', () => {
    // Purpose: `permissions` and `added` are new; a missing one must not throw
    // and empty the inbox. It reads as null: nothing known, nothing added.
    const parsed = PendingExtensionApprovalsResponseSchema.parse({
      approvals: [OLDER_SERVER_ROW],
    });
    expect(parsed.approvals[0]).toMatchObject({ permissions: null, added: null });
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

describe('BRIDGE_WRITES: one table for the card, the bridge gate and the server (DOR-3293)', () => {
  it('lists every open write for any app, and rooms or forward only when declared', async () => {
    const { bridgeWritesFor } = await import('../extension-approval-schemas.js');
    expect(bridgeWritesFor({})).toEqual(['data', 'canvas', 'inbox', 'work', 'files']);
    expect(bridgeWritesFor({ capabilities: { rooms: true, forward: true } })).toEqual([
      'data',
      'canvas',
      'inbox',
      'work',
      'files',
      'rooms',
      'forward',
    ]);
  });

  it('gates a declared write by the same rule the card lists it by', async () => {
    const { BRIDGE_WRITES, bridgeWriteAllowed, bridgeWritesFor } =
      await import('../extension-approval-schemas.js');
    for (const manifest of [
      {},
      { capabilities: { rooms: true } },
      { capabilities: { forward: true } },
    ]) {
      const listed = new Set(bridgeWritesFor(manifest));
      for (const write of BRIDGE_WRITES) {
        for (const method of write.methods) {
          expect(bridgeWriteAllowed(manifest, method), `${method}`).toBe(listed.has(write.key));
        }
      }
    }
    // A call the table does not list is not a write it gates.
    expect(bridgeWriteAllowed({}, 'rooms.listRooms')).toBe(true);
    // Only `true` declares: a truthy look-alike does not.
    expect(bridgeWriteAllowed({ capabilities: { rooms: 'yes' as never } }, 'rooms.reply')).toBe(
      false
    );
  });
});
