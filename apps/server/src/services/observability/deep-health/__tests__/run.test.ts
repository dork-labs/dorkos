import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectAgentManifests,
  collectTranscriptSessionIds,
  listAgentHomeDirectories,
} from '../collect.js';
import { runDeepHealthChecks, type DeepHealthDeps } from '../run.js';

/** A throwaway DORK_HOME-shaped tree, built per test so the real one is never touched. */
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-health-'));
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

/** Write `<projects>/<slug>/<sessionId>.jsonl`. */
function writeTranscript(projectsRoot: string, slug: string, sessionId: string): void {
  fs.mkdirSync(path.join(projectsRoot, slug), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, slug, `${sessionId}.jsonl`), '{}\n');
}

describe('collectTranscriptSessionIds', () => {
  it('finds session ids across every slug folder and every root', () => {
    const rootA = path.join(tmpHome, 'a', 'projects');
    const rootB = path.join(tmpHome, 'b', 'projects');
    writeTranscript(rootA, '-Users-me-one', 'session-1');
    writeTranscript(rootA, '-Users-me-two', 'session-2');
    writeTranscript(rootB, '-Users-me-three', 'session-3');

    expect(collectTranscriptSessionIds([rootA, rootB])).toEqual(
      new Set(['session-1', 'session-2', 'session-3'])
    );
  });

  it('ignores non-transcript files and missing roots', () => {
    const root = path.join(tmpHome, 'projects');
    writeTranscript(root, 'slug', 'real');
    fs.writeFileSync(path.join(root, 'slug', 'notes.txt'), 'hi');

    expect(collectTranscriptSessionIds([root, path.join(tmpHome, 'nope')])).toEqual(
      new Set(['real'])
    );
  });
});

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
  function healthyDeps(projectsRoot: string, agentDir: string): DeepHealthDeps {
    return {
      dorkHome: tmpHome,
      roomSessions: { listRoomSessions: () => [{ roomId: 'r', authorId: 'a', sessionId: 'sess' }] },
      transcriptProjectRoots: () => [projectsRoot],
      runtimeForSession: async () => 'claude-code',
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
    const projectsRoot = path.join(tmpHome, 'projects');
    writeTranscript(projectsRoot, 'slug', 'sess');
    const agentDir = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));

    const results = await runDeepHealthChecks(healthyDeps(projectsRoot, agentDir));

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('catches every broken state at once', async () => {
    const projectsRoot = path.join(tmpHome, 'projects');
    writeTranscript(projectsRoot, 'slug', 'some-other-session');
    const original = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));
    writeManifest(path.join(tmpHome, 'agents', 'copy'), JSON.stringify({ id: 'agent-a' }));

    const deps: DeepHealthDeps = {
      ...healthyDeps(projectsRoot, original),
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

  it('skips a session whose runtime keeps no transcript', async () => {
    const projectsRoot = path.join(tmpHome, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const agentDir = writeManifest(path.join(tmpHome, 'proj'), JSON.stringify({ id: 'agent-a' }));

    const results = await runDeepHealthChecks({
      ...healthyDeps(projectsRoot, agentDir),
      runtimeForSession: async () => 'codex',
    });

    expect(results[0]?.status).toBe('pass');
  });

  it('reports info, not failure, for subsystems that are not running', async () => {
    const results = await runDeepHealthChecks({ dorkHome: tmpHome });

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'info')).toBe(true);
    expect(results.every((r) => r.detail?.startsWith('Skipped'))).toBe(true);
  });
});
