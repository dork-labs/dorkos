/**
 * Retiring the four `agentContext.*Tools` switches (spec `agent-permissions`
 * D13, phase 3) across the real `conf`/Ajv seam: each switch a person turned off
 * becomes its area Blocked for everyone, and the section leaves the file.
 *
 * Every assertion reads `config.json` from DISK (DOR-1496): conf's read path
 * fills defaults into a throwaway copy, so an in-memory read would pass with the
 * retirement doing nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temp data directory whose config still carries the retired switches. */
function seed(
  agentContext: Record<string, unknown> | undefined,
  permissions?: Record<string, unknown>,
  migratedTo?: string
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-agent-context-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      ...(agentContext !== undefined ? { agentContext } : {}),
      ...(permissions ? { permissions } : {}),
      ...(migratedTo ? { __internal__: { migrations: { version: migratedTo } } } : {}),
    })
  );
  return dir;
}

/** The stored file, as the next boot will read it. */
function readDisk(dir: string): {
  agentContext?: unknown;
  permissions?: { defaults?: { areas?: Record<string, string> } };
} {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

const ALL_ON = { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true };

describe('retiring agentContext (real conf + Ajv)', () => {
  it.each([
    ['tasksTools', 'tasks'],
    ['relayTools', 'messages'],
    ['meshTools', 'agents'],
    ['adapterTools', 'connections'],
  ])('turns %s off into %s Blocked for everyone, and removes the section', (key, area) => {
    const dir = seed({ ...ALL_ON, [key]: false });
    const manager = new ConfigManager(dir);

    expect(manager.retireAgentContext()).toEqual([area]);

    const disk = readDisk(dir);
    expect(disk.permissions?.defaults?.areas).toEqual({ [area]: 'blocked' });
    expect(disk).not.toHaveProperty('agentContext');
  });

  it('Blocks all four when every switch was off', () => {
    const dir = seed({
      relayTools: false,
      meshTools: false,
      adapterTools: false,
      tasksTools: false,
    });
    const blocked = new ConfigManager(dir).retireAgentContext();

    expect(blocked?.sort()).toEqual(['agents', 'connections', 'messages', 'tasks']);
    expect(readDisk(dir).permissions?.defaults?.areas).toEqual({
      tasks: 'blocked',
      messages: 'blocked',
      agents: 'blocked',
      connections: 'blocked',
    });
  });

  it('changes no permission when every switch was on, and still removes the section', () => {
    const dir = seed(ALL_ON);
    expect(new ConfigManager(dir).retireAgentContext()).toEqual([]);
    const disk = readDisk(dir);
    expect(disk.permissions?.defaults?.areas ?? {}).toEqual({});
    expect(disk).not.toHaveProperty('agentContext');
  });

  it('keeps an area a person already set through DorkOS', () => {
    const dir = seed(
      { ...ALL_ON, relayTools: false },
      { preset: 'full', defaults: { areas: { messages: 'ask' }, actions: {} } }
    );
    expect(new ConfigManager(dir).retireAgentContext()).toEqual([]);
    expect(readDisk(dir).permissions?.defaults?.areas).toEqual({ messages: 'ask' });
  });

  it('answers null, and writes nothing, once the section is gone', () => {
    const dir = seed(undefined);
    const manager = new ConfigManager(dir);
    const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    expect(manager.retireAgentContext()).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  });

  it('still retires on an install already migrated to 0.83.0, whose migrations will not run again', () => {
    const dir = seed(
      { ...ALL_ON, meshTools: false },
      { preset: 'careful', defaults: { areas: {}, actions: {} } },
      '0.83.0'
    );
    expect(new ConfigManager(dir).retireAgentContext()).toEqual(['agents']);
    const disk = readDisk(dir);
    expect(disk.permissions?.defaults?.areas).toEqual({ agents: 'blocked' });
    expect(disk).not.toHaveProperty('agentContext');
  });

  it('is a no-op the second time', () => {
    const dir = seed({ ...ALL_ON, tasksTools: false });
    const manager = new ConfigManager(dir);
    expect(manager.retireAgentContext()).toEqual(['tasks']);
    expect(manager.retireAgentContext()).toBeNull();
    expect(readDisk(dir).permissions?.defaults?.areas).toEqual({ tasks: 'blocked' });
  });
});
