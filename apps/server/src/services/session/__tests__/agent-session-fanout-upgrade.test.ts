/**
 * An agent's session list shows the same room sessions before and after room
 * turns moved home (spec `agent-home-desk` §8.1, §11 "Migration").
 *
 * Real files: a DorkOS data folder with a room worktree on disk, a Claude config
 * folder with a transcript filed under that worktree's slug, and a Codex-shaped
 * thread whose recorded folder is the worktree. The two fake runtimes list the
 * way the real ones do — Claude Code by the slug of the folder it is asked
 * about, Codex by the folder a thread was FIRST seen in — so the only thing
 * under test is the wiring: the move, and the frozen list that feeds the
 * fan-out's `extraDirs` afterwards.
 *
 * Seeded: feeding `extraDirs` nothing after the move (claude-code needs none)
 * reddens it through the Codex session, which only the frozen list keeps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { fanOutAgentSessions, setAgentSessionSources } from '../agent-session-fanout.js';
import { RoomWorktreeManager } from '../../rooms/repo/room-worktree-manager.js';
import { projectSlug } from '../../runtimes/claude-code/sessions/project-slug.js';
import {
  frozenRoomWorktrees,
  migrateRoomTranscripts,
  roomWorktreesOfAgent,
} from '../../runtimes/claude-code/migrate-room-transcripts.js';

const ROOM = '01JAAAAAAAAAAAAAAAAAAAAAAA';

describe('an agent’s room sessions across the upgrade', () => {
  let base: string;
  let dorkHome: string;
  let claudeRoot: string;
  let ana: string;
  let worktree: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'fanout-upgrade-')));
    dorkHome = path.join(base, 'dork');
    claudeRoot = path.join(base, 'claude');
    ana = path.join(base, 'agents', 'ana');
    await mkdir(ana, { recursive: true });
    worktree = path.join(
      dorkHome,
      'rooms',
      ROOM,
      'worktrees',
      RoomWorktreeManager.slugFor('Ana', ana)
    );
    await mkdir(worktree, { recursive: true });
    // A room conversation from before the upgrade, filed under the worktree's
    // slug, settled an hour ago.
    const file = path.join(claudeRoot, 'projects', projectSlug(worktree), 'room-chat.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: 'user', cwd: worktree }) + '\n');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(file, hourAgo, hourAgo);
  });

  afterEach(async () => {
    setAgentSessionSources(null);
    await rm(base, { recursive: true, force: true });
  });

  /** Claude Code lists a folder by its slug, with each record's own `cwd`. */
  function claudeLike(): FakeAgentRuntime {
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.listSessions.mockImplementation(async (dir: string) => {
      const folder = path.join(claudeRoot, 'projects', projectSlug(dir));
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        return [];
      }
      const sessions: Session[] = [];
      for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
        const first = JSON.parse(
          (await readFile(path.join(folder, name), 'utf-8')).split('\n')[0]!
        );
        sessions.push(session(name.replace(/\.jsonl$/, ''), first.cwd, 'claude-code'));
      }
      return sessions;
    });
    return runtime;
  }

  /** Codex lists a thread under the folder it was first seen in, forever. */
  function codexLike(): FakeAgentRuntime {
    const runtime = new FakeAgentRuntime('codex');
    runtime.listSessions.mockImplementation(async (dir: string) =>
      dir === worktree ? [session('codex-room-thread', worktree, 'codex')] : []
    );
    return runtime;
  }

  function session(id: string, cwd: string, runtime: string): Session {
    return {
      id,
      title: id,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      permissionMode: 'default',
      runtime,
      cwd,
    };
  }

  async function listedFor(runtimes: FakeAgentRuntime[]): Promise<string[]> {
    const { perPath } = await fanOutAgentSessions({ runtimes, agentPaths: [ana] });
    return perPath.flatMap((p) => p.members.map((m) => m.id)).sort();
  }

  it('lists the same room sessions before the move and after it', async () => {
    const runtimes = [claudeLike(), codexLike()];
    // Before: the live worktree list, as the old wiring fed it.
    setAgentSessionSources({
      extraDirs: async () => [worktree],
      boundSessionIds: async () => new Set<string>(),
    });
    const before = await listedFor(runtimes);
    expect(before).toEqual(['codex-room-thread', 'room-chat']);

    // The upgrade: transcripts move home, and the fan-out is fed the frozen list.
    const outcome = await migrateRoomTranscripts({
      dorkHome,
      claudeRoots: [claudeRoot],
      agentPaths: [ana],
    });
    expect(outcome.marker?.moved).toBe(1);
    const frozen = await frozenRoomWorktrees(dorkHome);
    setAgentSessionSources({
      extraDirs: async (agentPath) => roomWorktreesOfAgent(frozen, agentPath),
      boundSessionIds: async () => new Set<string>(),
    });

    expect(await listedFor(runtimes)).toEqual(before);
    // And the Claude Code transcript really is under the home's slug now.
    await expect(readdir(path.join(claudeRoot, 'projects', projectSlug(ana)))).resolves.toContain(
      'room-chat.jsonl'
    );
  });

  it('keeps a Codex room thread listed after its worktree is reaped', async () => {
    await migrateRoomTranscripts({ dorkHome, claudeRoots: [claudeRoot], agentPaths: [ana] });
    await rm(worktree, { recursive: true, force: true });
    const frozen = await frozenRoomWorktrees(dorkHome);
    setAgentSessionSources({
      extraDirs: async (agentPath) => roomWorktreesOfAgent(frozen, agentPath),
      boundSessionIds: async () => new Set<string>(),
    });

    expect(await listedFor([codexLike()])).toEqual(['codex-room-thread']);
  });

  it('gives an agent none of another agent’s room folders', async () => {
    const frozen = await frozenRoomWorktrees(dorkHome);

    expect(roomWorktreesOfAgent(frozen, ana)).toEqual([worktree]);
    expect(roomWorktreesOfAgent(frozen, path.join(base, 'agents', 'bo'))).toEqual([]);
  });
});
