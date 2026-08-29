/**
 * A room's repo is append-only, and this is the test that says so about the
 * WHOLE domain rather than about one function (spec `project-rooms` §3.6:
 * "History is append-only: no force-push, no reset verbs exist on any surface").
 *
 * Every other test here asserts that something works. This one asserts that
 * something is absent, which is a different job and needs a different shape:
 * absence cannot be proved by calling the code, because the way it fails is
 * that somebody ADDS a call nobody thought to test. So it reads the domain's
 * own source and refuses the vocabulary.
 *
 * **It scans the source deliberately, and the alternative is worse.** A test
 * that called `merge_to_room_main` and checked the reflog would prove that
 * today's merge does not rewrite history, and would say nothing at all about a
 * `reset --hard` added to the reap next month. What makes the guarantee real is
 * that the vocabulary is not available anywhere under the surface — so that is
 * what is checked, in the one directory that is allowed to run git for a room.
 *
 * **What a source grep cannot catch, stated rather than pretended away.** A
 * command assembled from pieces — `'re' + 'set'`, a template literal, a name
 * held in a variable — passes this test and runs anyway. That is inherent, and
 * chasing it would mean writing a parser. What the guard is worth is the case
 * that actually happens: somebody adds a plainly-spelled destructive command
 * because it was the obvious way to fix something, and this fails their build
 * with the reason in the message. It is a tripwire against drift, not a sandbox
 * against an author who means it — and the reviewer of a PR that obfuscates a
 * git command has a much louder signal than this test.
 *
 * **The walk recurses**, which it did not at first: `readdir` without
 * `recursive` read only the top level, so anything in a subdirectory of the
 * domain was invisible to a guard whose whole claim is "anywhere under here".
 *
 * Seeded defect: adding `await runGit(['reset', '--hard', 'main'], …)` anywhere
 * under `services/rooms/repo/` — at any depth — reddens it, naming the file and
 * the phrase.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roomsDomain } from '../../room-capabilities.js';

/** The domain directory — every module allowed to run git for a room. */
const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Git vocabulary that can destroy work, and would therefore be a change to what
 * a room's repo IS rather than a change to how it behaves.
 *
 * Each is spelled as it would appear in an argument array, because that is the
 * only way these commands are ever built here (`runGit` takes an array; there
 * is no shell). Adding one to this list is not a fix — the point is that none
 * of them appears.
 */
const FORBIDDEN: readonly { phrase: RegExp; why: string }[] = [
  { phrase: /'reset'/, why: 'git reset moves a branch off commits nobody else has a copy of' },
  { phrase: /'push'/, why: 'a room repo has no remote, and a push is how history leaves it' },
  {
    phrase: /'update-ref'/,
    why: 'the most direct rewrite there is — it repoints a branch with no safety check at all',
  },
  { phrase: /'--force'/, why: 'every force flag here overrides a refusal that is protecting work' },
  { phrase: /'-f'/, why: 'the short force flag, same reason' },
  { phrase: /'--hard'/, why: 'a hard reset throws away the working tree as well' },
  {
    phrase: /'-D'/,
    why: 'branch -D deletes a branch main does not contain; the domain uses -d, which refuses',
  },
  {
    phrase: /'-M'/,
    why: 'branch -M renames over an existing branch, which is a delete wearing a rename',
  },
  { phrase: /'clean'/, why: 'git clean deletes untracked files — somebody’s unsaved work' },
  {
    phrase: /'restore'|'switch'/,
    why: 'both discard working-tree changes; the domain never writes in a tree it does not own',
  },
  {
    phrase: /'reflog'/,
    why: 'the reflog is the last copy of a rewritten history; nothing here should be pruning it',
  },
  {
    phrase: /'filter-branch'|'rebase'|'commit-tree'/,
    why: 'history rewriting, in the three spellings git offers',
  },
];

/**
 * Every TypeScript module in the domain, at any depth, excluding its tests.
 *
 * `recursive` is load-bearing: without it this read only the top level, and a
 * guard that claims "anywhere under here" while looking at one directory is
 * worse than no guard, because it reads as coverage.
 */
async function domainSources(): Promise<{ name: string; source: string }[]> {
  const entries = await readdir(REPO_DIR, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      // The tests themselves name these commands on purpose — this file most of
      // all — and a guard that failed on its own vocabulary would be unusable.
      !path.join(entry.parentPath, entry.name).includes('__tests__')
  );
  return Promise.all(
    files.map(async (entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return { name: path.relative(REPO_DIR, full), source: await readFile(full, 'utf-8') };
    })
  );
}

describe('a room’s repo is append-only', () => {
  it('runs no git command that can destroy work', async () => {
    const found: string[] = [];
    for (const { name, source } of await domainSources()) {
      for (const { phrase, why } of FORBIDDEN) {
        if (phrase.test(source)) found.push(`${name} contains ${String(phrase)} — ${why}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('exposes exactly the room verbs, and no repo verb beyond the two', async () => {
    const tools = roomsDomain.capabilities.map((capability) => capability.surfaces.mcp?.toolName);
    // The whole hand, pinned. A new verb here is a new thing an agent can do in
    // somebody else's room, and it should be argued for in a review rather than
    // arrive with a passing suite.
    expect(tools).toEqual([
      'post_to_room',
      'react_to_room_entry',
      'merge_to_room_main',
      'room_repo_status',
      'read_room_history',
      'search_room_history',
      'list_member_rooms',
      'search_member_rooms',
      'get_room',
      'find_room',
      // The five that ARRANGE rooms (DOR-1611). They are here because the pin is
      // the WHOLE hand, not because they touch a room's files — none of them
      // does, which is the point: the repo verbs are still exactly the two
      // above. These five are additionally off until a person turns them on,
      // behind the `roomsManage` grant.
      'create_room',
      'add_room_members',
      'remove_room_members',
      'update_room',
      'leave_room',
    ]);
    // And nothing in the domain offers to give a room files: enabling a repo is
    // operator-only over HTTP (spec §3.2), because an agent that could hand
    // itself a writable working directory is the confused-deputy shape the
    // membership verbs already refuse.
    expect(tools.some((tool) => tool?.includes('enable'))).toBe(false);
  });
});
