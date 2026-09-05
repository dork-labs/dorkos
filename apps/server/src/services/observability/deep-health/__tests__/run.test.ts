import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { collectAgentManifests, listAgentHomeDirectories } from '../collect.js';
import { runDeepHealthChecks, type DeepHealthDeps } from '../run.js';

/** A throwaway DORK_HOME-shaped tree, built per test so the real one is never touched. */
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-health-'));
  // The shared binding probe asks the registry which runtime owns a session
  // (DOR-805), and that read needs a database. Empty, so every room binding here
  // is unbound and falls through to the agent's manifest.
  runtimeRegistry.setDb(createTestDb());
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Write `<dir>/.dork/agent.json` with the given raw contents. */
function writeManifest(dir: string, contents: string): string {
  fs.mkdirSync(path.join(dir, '.dork'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dork', 'agent.json'), contents);
  return dir;
}

describe('collectAgentManifests', () => {
  it('reads the id each folder claims', () => {
    const one = writeManifest(path.join(tmpHome, 'one'), JSON.stringify({ id: 'agent-a' }));
    const two = writeManifest(path.join(tmpHome, 'two'), JSON.stringify({ id: 'agent-b' }));

    expect(collectAgentManifests([one, two])).toEqual([
      { id: 'agent-a', directory: one },
      { id: 'agent-b', directory: two },
    ]);
  });

  it('skips folders with no manifest, bad JSON, or no id', () => {
    const good = writeManifest(path.join(tmpHome, 'good'), JSON.stringify({ id: 'agent-a' }));
    const broken = writeManifest(path.join(tmpHome, 'broken'), '{ not json');
    const idless = writeManifest(path.join(tmpHome, 'idless'), JSON.stringify({ name: 'x' }));
    const empty = path.join(tmpHome, 'empty');
    fs.mkdirSync(empty);

    expect(collectAgentManifests([good, broken, idless, empty])).toEqual([
      { id: 'agent-a', directory: good },
    ]);
  });

  it('deduplicates a folder passed twice', () => {
    const dir = writeManifest(path.join(tmpHome, 'one'), JSON.stringify({ id: 'agent-a' }));
    expect(collectAgentManifests([dir, dir])).toHaveLength(1);
  });
});

describe('listAgentHomeDirectories', () => {
  it('lists the folders under <dorkHome>/agents', () => {
    fs.mkdirSync(path.join(tmpHome, 'agents', 'dorkbot'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'agents', 'helper'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'agents', 'stray.json'), '{}');

    expect(listAgentHomeDirectories(tmpHome).sort()).toEqual([
      path.join(tmpHome, 'agents', 'dorkbot'),
      path.join(tmpHome, 'agents', 'helper'),
    ]);
  });

  it('returns nothing when there is no agents folder', () => {
    expect(listAgentHomeDirectories(tmpHome)).toEqual([]);
  });
});

describe('runDeepHealthChecks', () => {
  /** A machine where every subsystem is present and nothing is wrong. */
  function healthyDeps(agentDir: string): DeepHealthDeps {
    return {
      dorkHome: tmpHome,
      roomSessions: { listRoomSessions: () => [{ roomId: 'r', authorId: 'a', sessionId: 'sess' }] },
      roomBindingTranscripts: {
        agentPathFor: () => agentDir,
        hasTranscript: () => Promise.resolve(true),
      },
      relay: { isAccessControlQuarantined: () => false, listAccessRules: () => [{}, {}] },
      adapters: {
        listUnparsedEntryIds: () => [],
        listAdapters: () => [{ config: { id: 'slack' } }],
        getBindingStore: () => ({ getAll: () => [{ adapterId: 'slack', agentId: 'agent-a' }] }),
      },
      mesh: { listWithPaths: () => [{ id: 'agent-a', projectPath: agentDir }] },
    };
  }

  it('passes every check on a healthy machine', async () => {
    const agentDir = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));

    const results = await runDeepHealthChecks(healthyDeps(agentDir));

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('catches every broken state at once', async () => {
    const original = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));
    writeManifest(path.join(tmpHome, 'agents', 'copy'), JSON.stringify({ id: 'agent-a' }));

    const deps: DeepHealthDeps = {
      ...healthyDeps(original),
      roomBindingTranscripts: {
        agentPathFor: () => original,
        hasTranscript: () => Promise.resolve(false),
      },
      relay: { isAccessControlQuarantined: () => true, listAccessRules: () => [] },
      adapters: {
        listUnparsedEntryIds: () => ['broken-slack'],
        listAdapters: () => [],
        getBindingStore: () => ({ getAll: () => [{ adapterId: 'slack', agentId: 'ghost' }] }),
      },
    };

    const results = await runDeepHealthChecks(deps);
    const statuses = results.map((r) => r.status);

    expect(statuses).toEqual(['warn', 'fail', 'warn', 'warn', 'warn']);
  });

  it('leaves out a binding whose author is not an agent this install knows', async () => {
    const agentDir = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));

    const results = await runDeepHealthChecks({
      ...healthyDeps(agentDir),
      roomBindingTranscripts: {
        agentPathFor: () => null,
        // Would report the binding as orphaned if it were ever asked.
        hasTranscript: () => Promise.resolve(false),
      },
    });

    expect(results[0]?.status).toBe('pass');
    expect(results[0]?.detail).toContain('0 room members');
  });

  it('reports info, not failure, for subsystems that were never turned on', async () => {
    const results = await runDeepHealthChecks({ dorkHome: tmpHome });

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'info')).toBe(true);
    expect(results.every((r) => r.detail?.startsWith('Skipped'))).toBe(true);
  });

  it('tells a subsystem that failed to start apart from one that was never on', async () => {
    const results = await runDeepHealthChecks({
      dorkHome: tmpHome,
      relayFailedToStart: true,
      adaptersFailedToStart: true,
      meshFailedToStart: true,
    });

    // Room transcripts still just "not available" — no flag says otherwise.
    expect(results[0]?.status).toBe('info');
    for (const result of results.slice(1)) {
      expect(result.status).toBe('warn');
      expect(result.detail).toContain('failed to start');
    }
  });

  // The endpoint is read during an incident, which is exactly when a subsystem
  // is most likely to throw instead of answering. RelayCore's assertOpen() does
  // precisely that once it is closed.
  it('contains a throwing dependency to its own line and still answers', async () => {
    const agentDir = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));

    const results = await runDeepHealthChecks({
      ...healthyDeps(agentDir),
      relay: {
        isAccessControlQuarantined: () => {
          throw new Error('RelayCore is closed (/Users/someone/.dork/relay)');
        },
        listAccessRules: () => [],
      },
    });

    expect(results).toHaveLength(5);
    expect(results[1]?.status).toBe('warn');
    expect(results[1]?.label).toContain('Could not run the check');
    // Content-free: the thrown error's path must not ride along.
    expect(JSON.stringify(results[1])).not.toContain('/Users/someone');
    // The other four are untouched.
    for (const index of [0, 2, 3, 4]) {
      expect(results[index]?.status).toBe('pass');
    }
  });

  it('contains a throwing room-store read too', async () => {
    const results = await runDeepHealthChecks({
      dorkHome: tmpHome,
      roomSessions: {
        listRoomSessions: () => {
          throw new Error('database is locked');
        },
      },
      roomBindingTranscripts: {
        agentPathFor: () => '/agents/ana',
        hasTranscript: () => Promise.resolve(true),
      },
    });

    expect(results[0]?.status).toBe('warn');
    expect(results[0]?.label).toContain('Could not run the check');
    expect(JSON.stringify(results[0])).not.toContain('database is locked');
  });

  it('reports info rather than a confident pass when nothing could be probed', async () => {
    const agentDir = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));

    const results = await runDeepHealthChecks({
      ...healthyDeps(agentDir),
      roomBindingTranscripts: {
        agentPathFor: () => agentDir,
        hasTranscript: () => Promise.reject(new Error('EACCES')),
      },
    });

    expect(results[0]?.status).toBe('info');
    expect(results[0]?.label).toContain('Could not check');
  });
});
