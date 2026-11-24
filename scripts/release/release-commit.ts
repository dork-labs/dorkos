/**
 * Build the daily release commit for a release point P (DOR-5123, design §3).
 *
 * Runs from main's tools with P checked out as data: it reads P's files and
 * never imports, installs or runs anything from P. No clock, no network. Same
 * inputs, same bytes.
 *
 *   node scripts/release/release-commit.ts --repo <P checkout> --previous 0.141.0 \
 *     --date 2026-11-24 [--version X.Y.Z] [--commits <file>] [--out <dir>] [--json]
 *
 * - `--previous`: the last released version; P's VERSION must equal it.
 * - `--date`: the release date. Required, never taken from the clock.
 * - `--version`: overrides the bump; must be greater than `--previous`.
 * - `--commits`: `<sha> <subject>` per line for `v<previous>..P`, which the
 *   workflow writes; the PR body lists its `feat`/`fix` commits with no fragment.
 * - `--out`: an empty directory outside the checkout. Gets `tree/<path>` for
 *   every added or modified file, `plan.json`, `notes.md` and `pr-body.md`.
 * - `--json`: print `plan.json` instead of the summary.
 * - `--dry-run` is the default and the only mode. `--commit` is refused:
 *   `commitViaGitData` is not wired until go-live.
 *
 * Exit 0: planned (and written, with `--out`). Exit 1: refused, for example
 * nothing to release or a commit `release-branch-contents` would reject.
 * Exit 2: bad arguments or an unreadable checkout.
 *
 * @module scripts/release/release-commit
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runIfMain } from '../../packages/cli/scripts/release-branch/entry.ts';
import { ReleaseCommitError } from './errors.ts';
import { buildReleasePlan, planJson, type ReleasePlan, type RepoReader } from './plan.ts';

/** The message `--commit` is refused with. */
export const COMMIT_NOT_WIRED =
  'Committing is not wired until go-live. daily-release.yml will call commitViaGitData; until then this tool only plans (--dry-run).';

/** A {@link RepoReader} over a checkout on disk that refuses symlinks and paths outside it. */
export function diskReader(repoDir: string): RepoReader {
  const root = realpathSync(repoDir);
  const resolve = (relative: string) => {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep))
      throw new ReleaseCommitError(`${relative} is outside the checkout.`);
    if (existsSync(full) && lstatSync(full).isSymbolicLink())
      throw new ReleaseCommitError(`${relative} is a symlink; the release reads only real files.`);
    return full;
  };
  return {
    read(relative) {
      const full = resolve(relative);
      if (!existsSync(full) || !lstatSync(full).isFile())
        throw new ReleaseCommitError(`The release point has no file ${relative}.`);
      return readFileSync(full, 'utf8');
    },
    list(relative) {
      const full = resolve(relative);
      if (!existsSync(full)) return [];
      return readdirSync(full, { withFileTypes: true })
        .map((entry) => (entry.isFile() ? entry.name : `${entry.name}/`))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
}

/**
 * Write the plan's outputs into `outDir`, which must be empty (or absent) and
 * outside `repoDir`, so the release point is never written to.
 */
export function writeOutputs(plan: ReleasePlan, outDir: string, repoDir: string): string[] {
  const out = path.resolve(outDir);
  const repo = realpathSync(repoDir);
  const outReal = realpathOfNearest(out);
  if (outReal === repo || outReal.startsWith(repo + path.sep))
    throw new ReleaseCommitError('--out must be outside the release point checkout.');
  if (existsSync(out) && readdirSync(out).length)
    throw new ReleaseCommitError(`--out ${outDir} is not empty.`);
  const written: string[] = [];
  const put = (relative: string, text: string) => {
    const full = path.join(out, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    written.push(relative);
  };
  for (const change of plan.changes)
    if (change.after !== undefined) put(path.join('tree', change.path), change.after);
  put('plan.json', planJson(plan));
  put('notes.md', plan.notes);
  put('pr-body.md', plan.prBody);
  return written;
}

/**
 * The real path of `target`, resolving symlinks in the part of it that exists:
 * on macOS the temp folder is a link (`/var` to `/private/var`), so comparing a
 * not-yet-created path with a real one would miss that it sits inside it.
 */
function realpathOfNearest(target: string): string {
  let existing = target;
  while (!existsSync(existing) && path.dirname(existing) !== existing)
    existing = path.dirname(existing);
  return path.join(realpathSync(existing), path.relative(existing, target));
}

/** A few lines for a person reading the workflow log. */
export function summarize(plan: ReleasePlan): string {
  const { decision } = plan;
  return [
    `Release v${plan.version} (from ${plan.previous}, ${decision.bump}: ${decision.reason})`,
    `  breaking: ${decision.breaking ? 'yes' : 'no'}`,
    `  fragments: ${plan.fragments.length}`,
    `  files: ${plan.changes.map((change) => `${change.status} ${change.path}`).join('\n         ')}`,
    `  commits with no fragment: ${plan.unfragmented.length}`,
    '  release-branch-contents: pass',
  ].join('\n');
}

const OPTIONS = {
  repo: { type: 'string' },
  previous: { type: 'string' },
  date: { type: 'string' },
  version: { type: 'string' },
  commits: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  commit: { type: 'boolean' },
} as const;

/** Run the CLI over `argv`; returns the exit code. */
export function main(argv: readonly string[]): number {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const { values } = parsed;
  if (values.commit) {
    console.error(COMMIT_NOT_WIRED);
    return 2;
  }
  if (!values.repo || !values.previous || !values.date) {
    console.error('--repo, --previous and --date are all required.');
    return 2;
  }
  try {
    const plan = buildReleasePlan({
      reader: diskReader(values.repo),
      previous: values.previous,
      date: values.date,
      ...(values.version === undefined ? {} : { version: values.version }),
      ...(values.commits === undefined ? {} : { commits: readFileSync(values.commits, 'utf8') }),
    });
    if (values.out) writeOutputs(plan, values.out, values.repo);
    console.log(values.json ? planJson(plan).trimEnd() : summarize(plan));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof ReleaseCommitError ? 1 : 2;
  }
}

runIfMain(import.meta.url, () => main(process.argv.slice(2)));
