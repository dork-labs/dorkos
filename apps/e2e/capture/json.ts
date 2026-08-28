import fs from 'fs/promises';
import prettier from 'prettier';

/**
 * Prettier-stable JSON emission for the capture pipeline's *committed* files.
 *
 * The trap this exists to close: `JSON.stringify(value, null, 2)` fully expands
 * every array, one element per line, while Prettier *collapses* an array that
 * fits inside `printWidth`. A manifest row like
 *
 * ```json
 *   "consumers": [
 *     "marketing",
 *     "docs"
 *   ]
 * ```
 *
 * is what `JSON.stringify` emits and
 *
 * ```json
 *   "consumers": ["marketing", "docs"]
 * ```
 * is what Prettier demands. So a hand-rolled `JSON.stringify` writer produces a
 * file `prettier --check` rejects on *every* run.
 *
 * That normally hides: the lefthook `pre-commit` hook runs `prettier --write` on
 * staged files with `stage_fixed: true`, silently repairing the manifest before
 * it is committed. Any commit that skips hooks — `--no-verify`, or a worktree
 * with no `node_modules` where lefthook cannot run — lands it unformatted. On
 * 2026-08-24 the v0.64.0 release did exactly that and pushed three unformatted
 * capture files straight to `main`; because the merge-queue typecheck job runs
 * `prettier --check` over the whole tree, **every queued PR was ejected** until
 * a hotfix reformatted them (DOR-1510).
 *
 * The repo's `.prettierignore` states the governing rule for generated files: a
 * generator that lives *outside* the repo gets its output ignored (there is
 * nothing to teach), but a generator that lives *in* the repo gets taught to
 * emit Prettier-clean bytes so the file stays checked — exactly what
 * `specs/manifest.json` does. The capture writers are in-repo, so they are
 * taught here rather than ignored.
 *
 * Formatting goes through the real Prettier API with the repo config resolved
 * from the *target path*, not a hand-copied option set, so the output stays
 * byte-identical to the CI gate forever — including if `.prettierrc` changes.
 * Cost is ~170ms and it runs **once** per capture (and once per archive), never
 * on the per-asset path that runs 40+ times, so the pipeline is unaffected.
 *
 * Do not "simplify" a caller back to `JSON.stringify` + `writeFile`. It will
 * look fine locally — the pre-commit hook will keep covering for it — and then
 * redden `main` for everyone the next time a release pushes without hooks.
 *
 * Only files that are **committed** need this. The media library under
 * `apps/e2e/capture/library/` is gitignored, so its writers stay on plain
 * `JSON.stringify` and pay nothing.
 *
 * @module capture/json
 */

/**
 * Serialize `value` as JSON formatted exactly the way `prettier --check` would
 * want it at `filePath`. `filePath` need not exist yet — it only selects which
 * `.prettierrc` applies.
 */
export async function formatJson(value: unknown, filePath: string): Promise<string> {
  const config = await prettier.resolveConfig(filePath);
  return prettier.format(`${JSON.stringify(value, null, 2)}\n`, {
    ...config,
    filepath: filePath,
    parser: 'json',
  });
}

/** Write `value` to `filePath` as Prettier-clean JSON. See {@link formatJson}. */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, await formatJson(value, filePath));
}
