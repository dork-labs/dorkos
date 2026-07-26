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
 * `apps/server/src` (where it was read) and `packages/` (where every one of its
 * eight remaining references lived, in the eval harness). Both, not either: a
 * guard covering only one of them would look identical from the outside and
 * would miss half the surface it exists to protect.
 *
 * `specs/` is deliberately NOT covered. Those mentions are a record of what was
 * true when they were written, and rewriting history to make a guard pass is
 * how a repo loses the ability to explain itself. `decisions/`, `research/`, and
 * `changelog/` are out for the same reason.
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

/** The two trees the guard covers, relative to the repository root. */
const SCOPES = ['apps/server/src', 'packages'];

/** Repository root, resolved from this file rather than from the cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Tracked files under `scopes` whose working-tree contents mention `needle`.
 *
 * `git grep` searches TRACKED files in the working tree, which is what makes the
 * result both correct and cheap: build output (`dist/`) and `node_modules/` are
 * gitignored and therefore invisible, so no hand-maintained skip list can rot,
 * and an uncommitted reintroduction is still caught.
 *
 * A `git` failure THROWS rather than returning an empty list. A guard that
 * quietly reports "nothing found" when it could not look is worse than no guard,
 * and exit code 1 (the honest "no matches") is the only non-zero status treated
 * as a result.
 *
 * @param needle - The fixed string to search for.
 * @param scopes - Pathspecs to search within, relative to the repository root.
 * @returns Repository-relative paths of every file that mentions it.
 */
function trackedFilesMentioning(needle: string, scopes: string[]): string[] {
  try {
    const stdout = execFileSync(
      'git',
      ['grep', '--files-with-matches', '-F', needle, '--', ...scopes],
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
  it('is mentioned nowhere under apps/server/src or packages/', () => {
    expect(
      trackedFilesMentioning(RETIRED_ENV_VAR, SCOPES),
      `The retired ${RETIRED_ENV_VAR} environment variable came back. It selected a ` +
        'confirmation provider that approved every marketplace install, uninstall, and ' +
        'package creation without asking anyone — a shipped way to switch a consent gate ' +
        'off. If automation needs an install to complete unattended, answer the approval ' +
        'the way a person does: poll GET /api/approvals/pending, then POST ' +
        '/api/approvals/:id/grant, presenting neither the agent nor the approval header. ' +
        'packages/evals/src/runner/approval-driver.ts is the worked example.'
    ).toEqual([]);
  });

  it('would report a reintroduction in EITHER covered tree, not just one', () => {
    // The guard above is a green that proves nothing on its own: an empty list is
    // also what a broken search returns. So prove the search works, in both
    // scopes independently — a guard scoped to only one of them would pass the
    // test above identically.
    //
    // `import` is chosen because it is guaranteed to be everywhere in both trees.
    for (const scope of SCOPES) {
      expect(trackedFilesMentioning('import', [scope]).length).toBeGreaterThan(0);
    }
  });
});
