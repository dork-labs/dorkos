/**
 * The identity observer at the registry seam — what fires, and what must not.
 *
 * `AgentRegistry` is the one place every agent identity write lands, which is
 * why the observer lives there instead of on each of the eight call sites that
 * register, rename or remove an agent. That only works if the contract is
 * exact, so this file pins both halves of it: the writes that ARE identity
 * news, and the writes that look like it and are not.
 *
 * @module mesh/__tests__/agent-identity-observer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { AgentRegistry } from '../agent-registry.js';
import type { AgentIdentityChange, AgentRegistryEntry } from '../agent-registry.js';
import { MeshCore } from '../mesh-core.js';

/** A complete registry entry, overridable field by field. */
function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    workspace: { mode: 'home' },
    id: '01JKABC00001',
    name: 'backend',
    description: 'Backend service agent',
    runtime: 'claude-code',
    capabilities: ['code-review'],
    behavior: { responseMode: 'always' },
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    projectPath: '/home/user/projects/backend',
    namespace: '',
    scanRoot: '',
    ...overrides,
  };
}

let db: Db;
let changes: AgentIdentityChange[];
let registry: AgentRegistry;

beforeEach(() => {
  db = createTestDb();
  changes = [];
  registry = new AgentRegistry(db, { onIdentityChange: (change) => changes.push(change) });
});

describe('identity writes fire the observer', () => {
  it('reports a first upsert as `registered`, with names and the path', () => {
    const entry = makeEntry({ displayName: 'Backend' });
    registry.upsert(entry);

    expect(changes).toEqual([
      {
        kind: 'registered',
        agentId: entry.id,
        projectPath: entry.projectPath,
        name: 'backend',
        displayName: 'Backend',
      },
    ]);
  });

  it('reports an upsert over an id it already holds as `updated`', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.upsert({ ...entry, name: 'backend-renamed' });

    expect(changes).toEqual([
      expect.objectContaining({ kind: 'updated', agentId: entry.id, name: 'backend-renamed' }),
    ]);
  });

  it('reports `update` once, carrying the new name', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.update(entry.id, { displayName: 'Renamed In Place' });

    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'updated',
        agentId: entry.id,
        displayName: 'Renamed In Place',
      }),
    ]);
  });

  it('reports `remove` once, with the path read before the row went', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.remove(entry.id);

    expect(changes).toEqual([
      {
        kind: 'removed',
        agentId: entry.id,
        projectPath: entry.projectPath,
        name: 'backend',
        displayName: undefined,
      },
    ]);
  });

  it('reports `relocate` as an update at the new path', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.relocate(entry.id, '/home/user/projects/backend-moved');

    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'updated',
        agentId: entry.id,
        projectPath: '/home/user/projects/backend-moved',
      }),
    ]);
  });

  it('reports the row a relocation displaced as removed, before the move', () => {
    const mover = makeEntry();
    const incumbent = makeEntry({ id: '01JKABC00002', projectPath: '/home/user/projects/other' });
    registry.upsert(mover);
    registry.upsert(incumbent);
    changes.length = 0;

    registry.relocate(mover.id, incumbent.projectPath);

    expect(changes.map((c) => [c.kind, c.agentId])).toEqual([
      ['removed', incumbent.id],
      ['updated', mover.id],
    ]);
  });

  it('reports the row an upsert displaced at the same path as removed', () => {
    const incumbent = makeEntry();
    registry.upsert(incumbent);
    changes.length = 0;

    const replacement = makeEntry({ id: '01JKABC00009' });
    registry.upsert(replacement);

    expect(changes.map((c) => [c.kind, c.agentId])).toEqual([
      ['removed', incumbent.id],
      ['registered', replacement.id],
    ]);
  });

  it('stays silent when a write found nothing to write', () => {
    registry.update('01JKNOSUCHAGENT', { name: 'ghost' });
    registry.remove('01JKNOSUCHAGENT');
    registry.relocate('01JKNOSUCHAGENT', '/tmp/nowhere');

    expect(changes).toEqual([]);
  });

  it('stays silent when an upsert is refused as a duplicate id', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    expect(registry.upsert({ ...entry, projectPath: '/somewhere/else' })).toBe('duplicate-id');
    expect(changes).toEqual([]);
  });
});

describe('writes that must NOT fire the observer', () => {
  // Health and liveness both write the agents table, and both happen on a
  // cadence nothing about a roster should follow: `updateHealth` on every
  // message an agent sends, the other two on the five-minute reconciler pass
  // that already broadcasts `mesh_liveness_changed`.
  it('updateHealth, markUnreachable and markReachable are silent', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.updateHealth(entry.id, new Date().toISOString(), 'message_sent');
    registry.markUnreachable(entry.id);
    registry.markReachable(entry.id);

    expect(changes).toEqual([]);
    // …and the writes really did land, so the silence is the contract and not
    // three no-ops passing for one.
    expect(registry.getWithHealth(entry.id)!.lastSeenEvent).toBe('message_sent');
  });

  // The unified scanner re-yields every manifest-bearing directory it walks
  // past and the reconciler scans every five minutes, so this exact call is
  // made for every registered agent on a five-minute cadence. Firing on it
  // would make `agents_changed` a periodic timer wearing an event's name.
  it('a re-upsert that writes the same values is silent', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.upsert(entry);
    registry.upsert({ ...entry });

    expect(changes).toEqual([]);
  });

  it('an update that changes no field is silent', () => {
    const entry = makeEntry();
    registry.upsert(entry);
    changes.length = 0;

    registry.update(entry.id, { name: entry.name });

    expect(changes).toEqual([]);
  });
});

describe('a throwing observer never costs the write', () => {
  it('logs and swallows, and the row is still there', () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const throwing = new AgentRegistry(db, {
      logger,
      onIdentityChange: () => {
        throw new Error('observer exploded');
      },
    });
    const entry = makeEntry();

    expect(() => throwing.upsert(entry)).not.toThrow();
    expect(throwing.get(entry.id)).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      '[Mesh] an agent identity observer threw',
      expect.objectContaining({ agentId: entry.id })
    );
  });
});

describe('MeshCore.onAgentsChanged', () => {
  it('fans identity writes out to every subscriber', () => {
    const mesh = new MeshCore({ db, defaultScanRoot: '/tmp/scan-root' });
    const first: AgentIdentityChange[] = [];
    const second: AgentIdentityChange[] = [];
    mesh.onAgentsChanged((change) => first.push(change));
    mesh.onAgentsChanged((change) => second.push(change));

    mesh.agentRegistry.upsert(makeEntry());

    expect(first).toEqual([expect.objectContaining({ kind: 'registered' })]);
    expect(second).toEqual(first);
  });

  it('one broken subscriber does not cost the others theirs', () => {
    const mesh = new MeshCore({
      db,
      defaultScanRoot: '/tmp/scan-root',
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const survivor: AgentIdentityChange[] = [];
    mesh.onAgentsChanged(() => {
      throw new Error('first subscriber exploded');
    });
    mesh.onAgentsChanged((change) => survivor.push(change));

    expect(() => mesh.agentRegistry.upsert(makeEntry())).not.toThrow();
    expect(survivor).toHaveLength(1);
  });
});
