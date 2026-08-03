/**
 * The retired marketplace auto-approve environment variable stays retired
 * (spec `agent-approval-settings` §3.9, DOR-501).
 *
 * It selected a confirmation provider that said yes to every marketplace
 * install, uninstall, and package creation without asking anyone. It was
 * undocumented, absent from CI, and scoped to tests by its own docstring — and
 * it was still a shipped code path that turned a consent gate off. It is gone,
 * along with the provider it selected. The eval that used it now answers its
 * own approval through `GET /api/approvals/pending` and
 * `POST /api/approvals/:id/grant`, which is both honest and a stronger test.
 *
 * ## Why a grep is the right guard here
 *
 * There is nothing left to assert behavior against: the branch, the provider,
 * and the schema entry are all deleted, so a behavioral test would be asserting
 * that a thing which does not exist does not happen. What can actually regress
 * is somebody adding it back — reading `process.env` directly, re-declaring it
 * in `env.ts`, or setting it from an eval case — and the only thing that catches
 * all three is the name itself.
 *
 * ## Scope, and what is deliberately outside it
 *
 * `apps/server/src` (where it was read), `packages/` (where every one of its
 * eight remaining references lived, in the eval harness), `.github` (the one
 * place this kind of variable historically wanted to live, as a workflow env
 * entry), and `contributing/` and `docs/` (where the retirement itself needs
 * documenting, not re-introducing). All five, not any one: a guard covering
 * only some of them would look identical from the outside and would miss the
 * rest of the surface it exists to protect.
 *
 * `specs/`, `decisions/`, `research/`, and `changelog/` are deliberately NOT
 * covered. Those mentions are a record of what was true when they were
 * written, and rewriting history to make a guard pass is how a repo loses the
 * ability to explain itself.
 *
 * ## This file does not exempt itself
 *
 * The needle is assembled from fragments at runtime, so the literal string
 * never appears in this source. That is not cosmetic: an exclusion list with
 * this file on it would be a hole exactly the shape of a guard, and the first
 * person to add a second entry to that list would widen it without noticing.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The retired variable's name, assembled so this file does not contain it.
 * See the module TSDoc on why self-exemption was rejected.
 */
const RETIRED_ENV_VAR = ['MARKETPLACE', 'AUTO', 'APPROVE'].join('_');

/** The trees the guard covers, relative to the repository root. */
const SCOPES = ['apps/server/src', 'packages', '.github', 'contributing', 'docs'];

/**
 * Released records that sit inside a covered tree.
 *
 * `docs/changelog.mdx` and `docs/changelog-archive.mdx` are not written; they are
 * copied, byte for byte, from `CHANGELOG.md` and `changelog/archive/` at release.
 * `changelog/` is already outside this guard's scope, and for the stated reason:
 * a changelog cannot report that a switch was removed without naming the switch.
 * v0.57.0 is the release that compiled such an entry, so the mirror inherited a
 * mention the source is allowed to have. Covering the mirror but not the source
 * was an accident of which trees got listed, and the only ways to clear it are to
 * edit a released record or to make the mirror stop matching what it mirrors.
 *
 * This is narrow on purpose: two files, both generated, both with an unscanned
 * source. Every hand-written page under `docs/` is still covered.
 */
const RELEASED_RECORD_PATHSPECS = [
  ':(exclude)docs/changelog.mdx',
  ':(exclude)docs/changelog-archive.mdx',
];

/** Repository root, resolved from this file rather than from the cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Tracked AND untracked files under `scopes` whose working-tree contents
 * mention `needle`.
 *
 * `git grep --untracked` searches tracked files in the working tree plus
 * untracked-but-not-ignored ones, which is what makes the result both correct
 * and cheap: build output (`dist/`) and `node_modules/` are gitignored and
 * therefore still invisible, so no hand-maintained skip list can rot, but a
 * brand-new file nobody has `git add`ed yet is no longer invisible too — a
 * plain (untracked-blind) `git grep` catches an uncommitted edit to a tracked
 * file but misses an uncommitted new file with the same string, which is a
 * gap `--untracked` closes.
 *
 * A `git` failure THROWS rather than returning an empty list. A guard that
 * quietly reports "nothing found" when it could not look is worse than no guard,
 * and exit code 1 (the honest "no matches") is the only non-zero status treated
 * as a result.
 *
 * {@link RELEASED_RECORD_PATHSPECS} is appended to every search, so the two
 * generated changelog mirrors are subtracted from whatever scope is passed in.
 *
 * @param needle - The fixed string to search for.
 * @param scopes - Pathspecs to search within, relative to the repository root.
 * @returns Repository-relative paths of every file that mentions it.
 */
function filesMentioning(needle: string, scopes: string[]): string[] {
  try {
    const stdout = execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '--files-with-matches',
        '-F',
        needle,
        '--',
        ...scopes,
        ...RELEASED_RECORD_PATHSPECS,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      }
    );
    return stdout.split('\n').filter((line) => line !== '');
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    // 1 is `git grep`'s "no lines matched", which is the passing case.
    if (status === 1) return [];
    throw err;
  }
}

describe('the marketplace auto-approve environment variable stays retired', () => {
  it('is mentioned nowhere under any covered tree', () => {
    expect(
      filesMentioning(RETIRED_ENV_VAR, SCOPES),
      `The retired ${RETIRED_ENV_VAR} environment variable came back. It selected a ` +
        'confirmation provider that approved every marketplace install, uninstall, and ' +
        'package creation without asking anyone — a shipped way to switch a consent gate ' +
        'off. If automation needs an install to complete unattended, answer the approval ' +
        'the way a person does: poll GET /api/approvals/pending, then POST ' +
        '/api/approvals/:id/grant, presenting neither the agent nor the approval header. ' +
        'packages/evals/src/runner/approval-driver.ts is the worked example.'
    ).toEqual([]);
  });

  it('would report a reintroduction in EVERY covered tree, not just one', () => {
    // The guard above is a green that proves nothing on its own: an empty list is
    // also what a broken search returns. So prove the search works, in each
    // scope independently — a guard scoped to only some of them would pass the
    // test above identically.
    //
    // `import` is chosen because it is guaranteed to be everywhere in every tree.
    for (const scope of SCOPES) {
      expect(filesMentioning('import', [scope]).length).toBeGreaterThan(0);
    }
  });
});
