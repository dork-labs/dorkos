import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentRegistry } from '../agent-registry.js';
import type { AgentRegistryEntry } from '../agent-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: '01JKABC00001',
    name: 'backend',
    description: 'Backend service agent',
    runtime: 'claude-code',
    capabilities: ['code-review', 'refactoring'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    projectPath: '/home/user/projects/backend',
    ...overrides,
  };
}

let tmpDir: string;
let registry: AgentRegistry;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-registry-test-'));
  const dbPath = path.join(tmpDir, 'mesh.db');
  registry = new AgentRegistry(dbPath);
});

afterEach(async () => {
  registry.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// WAL Mode
// ---------------------------------------------------------------------------

describe('WAL mode', () => {
  it('uses WAL journal mode', () => {
    const mode = registry.database.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });
});

// ---------------------------------------------------------------------------
// Insert and Get
// ---------------------------------------------------------------------------

describe('insert and get', () => {
  it('round-trips an agent entry by id', () => {
    const entry = makeEntry();
    registry.insert(entry);

    const result = registry.get(entry.id);
    expect(result).toBeDefined();
    expect(result!.id).toBe(entry.id);
    expect(result!.name).toBe(entry.name);
    expect(result!.description).toBe(entry.description);
    expect(result!.runtime).toBe(entry.runtime);
    expect(result!.capabilities).toEqual(entry.capabilities);
    expect(result!.behavior).toEqual(entry.behavior);
    expect(result!.budget).toEqual(entry.budget);
    expect(result!.registeredAt).toBe(entry.registeredAt);
    expect(result!.registeredBy).toBe(entry.registeredBy);
    expect(result!.projectPath).toBe(entry.projectPath);
  });

  it('returns undefined for non-existent id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------

describe('getByPath', () => {
  it('returns the correct agent for a project path', () => {
    const entry = makeEntry();
    registry.insert(entry);

    const result = registry.getByPath(entry.projectPath);
    expect(result).toBeDefined();
    expect(result!.id).toBe(entry.id);
  });

  it('returns undefined for non-existent path', () => {
    expect(registry.getByPath('/nonexistent/path')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('list', () => {
  it('returns all agents ordered by registered_at DESC', () => {
    const older = makeEntry({
      id: '01JKABC00001',
      projectPath: '/projects/older',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeEntry({
      id: '01JKABC00002',
      projectPath: '/projects/newer',
      registeredAt: '2026-02-01T00:00:00.000Z',
    });

    registry.insert(older);
    registry.insert(newer);

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(newer.id);
    expect(all[1].id).toBe(older.id);
  });

  it('filters by runtime', () => {
    registry.insert(makeEntry({ id: '01A', projectPath: '/p/a', runtime: 'claude-code' }));
    registry.insert(makeEntry({ id: '01B', projectPath: '/p/b', runtime: 'cursor' }));

    const filtered = registry.list({ runtime: 'claude-code' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].runtime).toBe('claude-code');
  });

  it('filters by capability', () => {
    registry.insert(
      makeEntry({ id: '01A', projectPath: '/p/a', capabilities: ['code-review', 'testing'] }),
    );
    registry.insert(
      makeEntry({ id: '01B', projectPath: '/p/b', capabilities: ['deployment'] }),
    );

    const filtered = registry.list({ capability: 'code-review' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('01A');
  });

  it('returns empty array when no agents exist', () => {
    expect(registry.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('modifies mutable fields and returns true', () => {
    registry.insert(makeEntry());

    const updated = registry.update('01JKABC00001', {
      name: 'updated-backend',
      description: 'Updated description',
      capabilities: ['new-cap'],
    });

    expect(updated).toBe(true);

    const result = registry.get('01JKABC00001');
    expect(result!.name).toBe('updated-backend');
    expect(result!.description).toBe('Updated description');
    expect(result!.capabilities).toEqual(['new-cap']);
  });

  it('returns false for non-existent id', () => {
    expect(registry.update('nonexistent', { name: 'new' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('deletes the agent and returns true', () => {
    registry.insert(makeEntry());
    expect(registry.remove('01JKABC00001')).toBe(true);
    expect(registry.get('01JKABC00001')).toBeUndefined();
  });

  it('returns false for non-existent id', () => {
    expect(registry.remove('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

describe('constraints', () => {
  it('throws on duplicate project_path', () => {
    registry.insert(makeEntry({ id: '01A' }));
    expect(() => registry.insert(makeEntry({ id: '01B' }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('survives close and reopen', async () => {
    const entry = makeEntry();
    registry.insert(entry);
    registry.close();

    // Reopen with same path
    const dbPath = path.join(tmpDir, 'mesh.db');
    registry = new AgentRegistry(dbPath);

    const result = registry.get(entry.id);
    expect(result).toBeDefined();
    expect(result!.name).toBe(entry.name);
    expect(result!.projectPath).toBe(entry.projectPath);
  });
});

// ---------------------------------------------------------------------------
// database getter (internal)
// ---------------------------------------------------------------------------

describe('database getter', () => {
  it('returns the underlying database instance', () => {
    const db = registry.database;
    expect(db).toBeDefined();
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });
});
