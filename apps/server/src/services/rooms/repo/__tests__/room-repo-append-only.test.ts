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
 * Seeded defect: adding `await runGit(['reset', '--hard', 'main'], …)` anywhere
 * under `services/rooms/repo/` reddens it, naming the file and the phrase.
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
  { phrase: /'--force'/, why: 'every force flag here overrides a refusal that is protecting work' },
  { phrase: /'-f'/, why: 'the short force flag, same reason' },
  { phrase: /'--hard'/, why: 'a hard reset throws away the working tree as well' },
  {
    phrase: /'-D'/,
    why: 'branch -D deletes a branch main does not contain; the domain uses -d, which refuses',
  },
  {
    phrase: /'filter-branch'|'rebase'|'commit-tree'/,
    why: 'history rewriting, in the three spellings git offers',
  },
];

/** Every TypeScript module in the domain, excluding its tests. */
async function domainSources(): Promise<{ name: string; source: string }[]> {
  const names = (await readdir(REPO_DIR)).filter((name) => name.endsWith('.ts'));
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(path.join(REPO_DIR, name), 'utf-8'),
    }))
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
    ]);
    // And nothing in the domain offers to give a room files: enabling a repo is
    // operator-only over HTTP (spec §3.2), because an agent that could hand
    // itself a writable working directory is the confused-deputy shape the
    // membership verbs already refuse.
    expect(tools.some((tool) => tool?.includes('enable'))).toBe(false);
  });
});
