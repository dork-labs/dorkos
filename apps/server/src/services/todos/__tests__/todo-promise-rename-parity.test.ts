/**
 * The rename of the three promise tools keeps permissions exactly as they were (DOR-3933,
 * Security's Must 1 for the to-dos spec).
 *
 * `commitment_add`, `commitment_update` and `commitments_list` (capability ids
 * `commitments.add|update|list`) became `todo_promise_add`, `todo_promise_update` and
 * `todo_promises_list` (`todo_promises.add|update|list`). Each one keeps its tier, its area, the
 * servers it is on and its hints; nothing answers to an old name any more; and a person's setting
 * stored under an old id moves to the new one, Blocked included, rather than falling back to a
 * default.
 *
 * The table below is the pre-rename truth, written out by hand on purpose: it must not be derived
 * from the code it checks. One column moved on purpose after the rename: `area`, which was `null`
 * for all three until DOR-3936 put them in the To-dos area, so a person's Blocked applies.
 */
import { describe, expect, it } from 'vitest';
import { foldLegacyPermissionFields } from '@dorkos/shared/mesh-schemas';
import { RENAMED_PERMISSION_ACTIONS } from '@dorkos/shared/permissions';
import { composeCapabilityRegistryForDocs } from '../../core/self-description/dorkos-registry.js';
import { DORKOS_AREAS } from '../../runtimes/shared/awareness/dorkos-areas.js';

/** Every renamed tool, as it was before the rename, beside its new names. */
const RENAMED = [
  {
    oldId: 'commitments.add',
    oldTool: 'commitment_add',
    id: 'todo_promises.add',
    tool: 'todo_promise_add',
    tier: 'act',
    area: 'todos',
    servers: ['in-session', 'external'],
    annotations: { idempotentHint: false },
  },
  {
    oldId: 'commitments.update',
    oldTool: 'commitment_update',
    id: 'todo_promises.update',
    tool: 'todo_promise_update',
    tier: 'act',
    area: 'todos',
    servers: ['in-session', 'external'],
    annotations: { idempotentHint: true },
  },
  {
    oldId: 'commitments.list',
    oldTool: 'commitments_list',
    id: 'todo_promises.list',
    tool: 'todo_promises_list',
    tier: 'observe',
    area: 'todos',
    servers: ['in-session', 'external'],
    annotations: { idempotentHint: true },
  },
] as const;

describe('the promise tools rename (DOR-3933)', () => {
  const registry = composeCapabilityRegistryForDocs();

  it.each(RENAMED)('$tool keeps the tier, area, servers and hints $oldTool had', (row) => {
    const capability = registry.get(row.id);
    expect(capability).toBeDefined();
    expect(capability!.tier).toBe(row.tier);
    expect(capability!.area).toBe(row.area);
    expect(capability!.surfaces.mcp?.toolName).toBe(row.tool);
    expect(capability!.surfaces.mcp?.servers).toEqual(row.servers);
    expect(capability!.surfaces.mcp?.annotations).toEqual(row.annotations);
  });

  it('leaves nothing answering to an old id or tool name', () => {
    for (const row of RENAMED) {
      expect(registry.get(row.oldId)).toBeUndefined();
      expect(registry.capabilities.some((c) => c.surfaces.mcp?.toolName === row.oldTool)).toBe(
        false
      );
    }
    expect(registry.capabilities.filter((c) => c.id.startsWith('commitments.'))).toEqual([]);
  });

  it('moves every old id to its new one, and only those', () => {
    expect(RENAMED_PERMISSION_ACTIONS).toEqual(
      Object.fromEntries(RENAMED.map((row) => [row.oldId, row.id]))
    );
  });

  it('carries a Blocked stored under an old id in an agent manifest over to the new id', () => {
    // Every manifest file read folds through this, before the schema (`AgentManifestFileSchema`).
    const manifest = foldLegacyPermissionFields({
      name: 'made-up-agent',
      permissions: {
        areas: { rooms: 'ask' },
        actions: {
          'commitments.add': 'blocked',
          'commitments.list': 'ask',
          'todo_promises.update': 'blocked',
          'commitments.update': 'allowed',
          'memory.write': 'blocked',
        },
      },
    }) as { permissions?: { areas?: unknown; actions?: unknown } };
    expect(manifest.permissions?.areas).toEqual({ rooms: 'ask' });
    expect(manifest.permissions?.actions).toEqual({
      'memory.write': 'blocked',
      'todo_promises.update': 'blocked',
      'todo_promises.add': 'blocked',
      'todo_promises.list': 'ask',
    });
  });

  it('files the new ids on the To-dos line of the agent awareness block (DOR-3936)', () => {
    const line = DORKOS_AREAS.find((area) => area.name === 'To-dos');
    expect(line?.covers).toContain('todo_promises.');
    expect(line?.areas).toEqual(['todos']);
    expect(DORKOS_AREAS.some((area) => area.covers.includes('commitments.'))).toBe(false);
  });
});
