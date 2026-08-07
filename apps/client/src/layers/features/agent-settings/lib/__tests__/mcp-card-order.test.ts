import { describe, it, expect } from 'vitest';
import type { ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { initialCardOrder, replayFrozenOrder } from '../mcp-card-order';

/** A managed server with only the fields the ordering rules read. */
function managed(
  overrides: Partial<ManagedMcpServerView> & { name: string }
): ManagedMcpServerView {
  return {
    enabled: true,
    connection: { transport: 'stdio', command: 'npx', args: [], env: {} },
    addedAt: '2026-01-01T00:00:00.000Z',
    addedBy: 'operator',
    ...overrides,
  };
}

describe('initialCardOrder', () => {
  it('puts what needs you first, then working, then elsewhere, then off', () => {
    const order = initialCardOrder({
      managed: [
        managed({ name: 'working' }),
        managed({ name: 'off', enabled: false }),
        managed({ name: 'broken' }),
        managed({ name: 'needs-auth', authStatus: 'needs-auth' }),
      ],
      live: new Map<string, McpServerEntry>([
        ['working', { name: 'working', type: 'stdio', status: 'connected' }],
        ['broken', { name: 'broken', type: 'stdio', status: 'failed', error: 'ECONNREFUSED' }],
      ]),
      discovered: [{ name: 'from-project', type: 'stdio', status: 'connected', scope: 'project' }],
    });

    expect(order).toEqual(['broken', 'needs-auth', 'working', 'from-project', 'off']);
  });

  it('keeps the input order inside a band', () => {
    // Two servers that both need you must not be re-ordered against each other:
    // the manifest's order is the only order a person has ever seen them in.
    const order = initialCardOrder({
      managed: [
        managed({ name: 'b', authStatus: 'needs-auth' }),
        managed({ name: 'a', authStatus: 'needs-auth' }),
      ],
      live: new Map(),
      discovered: [],
    });
    expect(order).toEqual(['b', 'a']);
  });
});

describe('replayFrozenOrder', () => {
  it('replays the frozen order and drops servers that are gone', () => {
    const { ordered, added } = replayFrozenOrder({
      frozen: ['a', 'b', 'c'],
      present: ['c', 'a'],
    });
    // Present order is deliberately ignored: the frozen order is the one on screen.
    expect(ordered).toEqual(['a', 'c']);
    expect(added).toEqual([]);
  });

  it('reports a newly arrived server separately, so it can be appended not inserted', () => {
    const { ordered, added } = replayFrozenOrder({
      frozen: ['a', 'b'],
      present: ['a', 'b', 'new'],
    });
    expect(ordered).toEqual(['a', 'b']);
    expect(added).toEqual(['new']);
  });
});
