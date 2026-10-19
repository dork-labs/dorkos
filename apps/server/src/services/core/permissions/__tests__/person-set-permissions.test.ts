/**
 * An agent can tighten its own settings file but never loosen itself past what
 * a person set (DOR-3107). The person-set record is the floor; every read takes
 * the stricter of the file and the floor, key by key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentPermissions, PermissionChangedMetadata } from '@dorkos/shared/permissions';
import { stricterPermissions, type NarrowingContext } from '../arrival-narrowing.js';
import { PersonSetPermissions } from '../person-set-permissions.js';
import { personSetFromHistory, seedPersonSetPermissions } from '../person-set-seed.js';
import { narrowingReader } from '../index.js';

/** Trusted preset, Act for everyone: an agent's Full autonomy is a raise. */
const context: NarrowingContext = {
  config: { preset: 'trusted', defaults: { areas: {}, actions: {} } },
  actions: new Map(),
  globalStop: 'act',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh record file in a temp folder. */
function recordFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-set-'));
  dirs.push(dir);
  return path.join(dir, 'person-set.json');
}

const quiet = { warn: () => {} };

/** One `permission.changed` event setting an agent's Files & commands stop. */
function filesEvent(
  agentId: string,
  after: string | null,
  attribution: PermissionChangedMetadata['attribution']
): { metadata: Record<string, unknown> } {
  return {
    metadata: {
      changes: [
        {
          target: { kind: 'agent', agentId, agentPath: `/a/${agentId}`, agentName: agentId },
          key: { kind: 'files' },
          before: null,
          after,
        },
      ],
      surface: 'permissions-page',
      attribution,
    },
  };
}

describe('stricterPermissions', () => {
  it('keeps a person’s Act when the agent wrote Full autonomy into its own file', () => {
    expect(
      stricterPermissions({ filesAndCommands: 'autonomy' }, { filesAndCommands: 'act' }, context)
    ).toEqual({ filesAndCommands: 'act' });
  });

  it('lets the agent tighten itself below what a person set', () => {
    expect(
      stricterPermissions({ filesAndCommands: 'ask' }, { filesAndCommands: 'autonomy' }, context)
    ).toEqual({ filesAndCommands: 'ask' });
  });

  it('honours Full autonomy only when a person set it', () => {
    expect(
      stricterPermissions(
        { filesAndCommands: 'autonomy' },
        { filesAndCommands: 'autonomy' },
        context
      )
    ).toEqual({ filesAndCommands: 'autonomy' });
    expect(
      stricterPermissions({ filesAndCommands: 'autonomy' }, undefined, context)
    ).toBeUndefined();
  });

  it('does not loosen an agent that deleted a stricter value a person set', () => {
    expect(stricterPermissions(undefined, { areas: { rooms: 'blocked' } }, context)).toEqual({
      areas: { rooms: 'blocked' },
    });
  });

  // Review finding 1: an agent's own stop beats every server stop, so it must
  // be no looser than the strictest of them, per-runtime ones included.
  it('drops Full autonomy an agent wrote when a person set its runtime to Ask', () => {
    expect(
      stricterPermissions({ filesAndCommands: 'autonomy' }, undefined, {
        ...context,
        globalStop: 'autonomy',
        runtimeStops: ['ask'],
      })
    ).toBeUndefined();
  });

  it('keeps what a person set when the agent deletes it, whatever the defaults', () => {
    expect(
      stricterPermissions(undefined, { filesAndCommands: 'act' }, { ...context, globalStop: null })
    ).toEqual({ filesAndCommands: 'act' });
  });

  it('drops an area the agent opened that no person opened', () => {
    expect(
      stricterPermissions({ areas: { permissions: 'allowed' } }, undefined, {
        ...context,
        config: { preset: 'careful', defaults: { areas: {}, actions: {} } },
      })
    ).toBeUndefined();
  });
});

describe('PersonSetPermissions', () => {
  it('gives every agent the defaults until it has been seeded', () => {
    const record = new PersonSetPermissions({ file: recordFile(), logger: quiet });
    record.set('a', { filesAndCommands: 'autonomy' });
    expect(record.isSeeded()).toBe(false);
    expect(record.get('a')).toBeUndefined();
  });

  it('keeps a person’s change made while the seed was running', () => {
    const record = new PersonSetPermissions({ file: recordFile(), logger: quiet });
    record.set('a', { filesAndCommands: 'autonomy' });
    record.seed(new Map([['a', { filesAndCommands: 'act' } as AgentPermissions]]));
    expect(record.get('a')).toEqual({ filesAndCommands: 'autonomy' });
  });

  it('keeps what DorkOS wrote across a restart', () => {
    const file = recordFile();
    const record = new PersonSetPermissions({ file, logger: quiet });
    record.seed(new Map());
    record.set('a', { filesAndCommands: 'autonomy' });
    const again = new PersonSetPermissions({ file, logger: quiet });
    expect(again.get('a')).toEqual({ filesAndCommands: 'autonomy' });
  });

  it('fails closed on a record it cannot read', () => {
    const file = recordFile();
    fs.writeFileSync(file, '{not json');
    const record = new PersonSetPermissions({ file, logger: quiet });
    expect(record.isSeeded()).toBe(false);
    expect(record.get('a')).toBeUndefined();
  });
});

describe('seeding from history', () => {
  it('replays a person’s changes, and ignores outside edits, boot folds and agents’ own', () => {
    const last = personSetFromHistory([
      filesEvent('a', 'act', 'signed-in'),
      filesEvent('a', 'autonomy', 'outside'),
      // A boot fold reads fields an agent can write into its own file.
      filesEvent('a', 'autonomy', 'upgrade'),
      // An agent's own change with no card: a past self-raise is never a floor.
      filesEvent('a', 'autonomy', 'agent'),
      filesEvent('b', 'autonomy', 'local-trust'),
    ]);
    expect(last.get('a')).toEqual({ filesAndCommands: 'act' });
    expect(last.get('b')).toEqual({ filesAndCommands: 'autonomy' });
  });

  // Security's case: an agent wrote Bypass into its own file before the upgrade.
  it('brings an agent that raised itself before the upgrade back to the person’s value', async () => {
    const record = new PersonSetPermissions({ file: recordFile(), logger: quiet });
    const files: Record<string, AgentPermissions> = {
      '/a/raised': { filesAndCommands: 'autonomy' },
      '/a/never-set': { filesAndCommands: 'autonomy' },
      '/a/trusted': { filesAndCommands: 'autonomy' },
    };
    await seedPersonSetPermissions({
      personSet: record,
      agents: () => [
        { id: 'raised', projectPath: '/a/raised' },
        { id: 'never-set', projectPath: '/a/never-set' },
        { id: 'trusted', projectPath: '/a/trusted' },
      ],
      readFile: async (p) => files[p],
      history: async () => [
        filesEvent('raised', 'act', 'signed-in'),
        filesEvent('raised', 'autonomy', 'outside'),
        filesEvent('trusted', 'autonomy', 'signed-in'),
      ],
      context: () => context,
    });

    const reader = narrowingReader(async (p) => files[p], {
      arrivals: { isPending: () => false } as never,
      personSet: record,
      agentAt: (p) => p.slice(3),
      context: () => context,
    });
    await expect(reader('/a/raised')).resolves.toEqual({ filesAndCommands: 'act' });
    await expect(reader('/a/never-set')).resolves.toBeUndefined();
    await expect(reader('/a/trusted')).resolves.toEqual({ filesAndCommands: 'autonomy' });
  });

  it('seeds only once', async () => {
    const record = new PersonSetPermissions({ file: recordFile(), logger: quiet });
    record.seed(new Map([['a', { filesAndCommands: 'ask' } as AgentPermissions]]));
    await seedPersonSetPermissions({
      personSet: record,
      agents: () => [{ id: 'a', projectPath: '/a/a' }],
      readFile: async () => ({ filesAndCommands: 'autonomy' }),
      history: async () => [filesEvent('a', 'autonomy', 'signed-in')],
      context: () => context,
    });
    expect(record.get('a')).toEqual({ filesAndCommands: 'ask' });
  });
});
