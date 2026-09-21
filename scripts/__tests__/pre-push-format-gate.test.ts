/**
 * Drift guard: the pre-push formatting check must stay wired.
 *
 * DOR-1839 is seven pull requests across five sessions going red on the required
 * `lint` check's `prettier --check .` in a single week — every one of them a
 * single `prettier --write` from green, one spec file twice from two different
 * sessions. `scripts/pre-push-format-check.sh` answers that, and
 * `scripts/test-pre-push-format-check.sh` tests the script thoroughly while
 * being entirely blind to whether anything CALLS it. That gap — a working guard
 * wired to nothing — is what this file closes, and the regression is invisible:
 * drop the command and every push still passes, a little faster, and the
 * seven-red week quietly resumes.
 *
 * IT IS ALSO NOW THE WHOLE HOOK. DOR-2160 removed the `tests` command from
 * `pre-push` after measuring that it either ran nothing (58 of 68 command runs
 * finished under 50 s) or could not finish (the other 10 took over 579 s, the
 * worst 2604, two killed), with nothing in between. So this check is the only
 * thing standing between a push and CI, and the ordering machinery that used to
 * keep it in front of the test sweep — `piped: true` and the two `priority`
 * keys — went with the second command, because an ordering among one command is
 * a claim about a file that no longer holds. The assertions below pin that it is
 * still exactly one command; `local-gate-shape.test.ts` beside this one pins
 * that no test command has come back without a ledger entry.
 *
 * WHY A VITEST TEST RATHER THAN A SHELL FIXTURE — the same reasoning its
 * neighbours give: `scripts/vitest.config.ts` globs every `*.test.ts` under a
 * `__tests__` directory, and that run is the last link of `test:scripts` (what
 * `pnpm verify` runs) and the final `harness` step of `scripts-test.yml`, so
 * this file registers itself in both with no wiring. `lefthook.yml` is already
 * inside that workflow's path filters, so the one PR shape these regressions
 * take — an edit to `lefthook.yml` alone — triggers the job that runs this file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const lefthookText = readFileSync(path.join(repoRoot, 'lefthook.yml'), 'utf8');

/** Path the lefthook command names, relative to the repo root it runs from. */
const CHECK_REL = 'scripts/pre-push-format-check.sh';

/**
 * The body of the `pre-push` hook, from its top-level key to the next one.
 *
 * Scoped rather than searched whole-file for the reason
 * `pre-push-gate-bounded.test.ts` gives: `piped` is a hook-level setting, and a
 * `piped: true` that had drifted onto `pre-commit` would satisfy a whole-file
 * search while leaving this hook exactly as concurrent as it was.
 *
 * A small scanner rather than a YAML dependency: `scripts/` has no package.json
 * and the `fixtures` job runs without a `pnpm install`, so nothing here may
 * import outside node's stdlib.
 */
function prePushBlock(yaml: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^pre-push:\s*$/.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The `priority` each 4-space-indented command declares, in declaration order.
 *
 * Lefthook 2.1.12 orders a piped hook's commands by `priority` and, for
 * commands that declare none, alphabetically by name — so a command missing
 * from this map is a command whose position is decided by its spelling.
 */
function commandPriorities(block: string): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  const lines = block.split('\n');
  let current: string | undefined;

  for (const line of lines) {
    const nameMatch = /^ {4}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (nameMatch) {
      current = nameMatch[1] as string;
      out.set(current, undefined);
      continue;
    }
    const priorityMatch = /^ {6}priority:\s*(\d+)\s*$/.exec(line);
    if (priorityMatch && current) out.set(current, Number(priorityMatch[1]));
  }

  return out;
}

const prePush = prePushBlock(lefthookText);
const priorities = commandPriorities(prePush);

describe('the pre-push formatting check is wired, and is the whole hook', () => {
  it('finds the pre-push hook and its one command at all', () => {
    // Without this, every assertion below passes vacuously the day the hook is
    // renamed or the scanner stops matching — the exact way a guard dies
    // quietly.
    expect(prePush).not.toBe('');
    expect([...priorities.keys()].sort()).toEqual(['formatting']);
  });

  it('declares no ordering, because there is nothing left to order', () => {
    // `piped` and `priority` earned their lines when a two-second check had to
    // preempt a six-minute sweep. With one command they assert an ordering
    // among nothing. Whoever adds a second command has to decide ordering
    // deliberately and put them back — this is the line that makes them.
    expect(/^ {2}piped:/m.test(prePush)).toBe(false);
    expect(priorities.get('formatting')).toBeUndefined();
  });

  it('runs the formatting check', () => {
    expect(
      prePush.includes(CHECK_REL),
      `lefthook.yml's pre-push hook no longer runs ${CHECK_REL}. Formatting is ` +
        'then unchecked until the required `lint` job on the PR, which is the ' +
        'seven-reds-in-a-week state DOR-1839 was opened about.'
    ).toBe(true);
  });

  it('names a script that is actually there', () => {
    // A path typo fails CLOSED here — `bash` exits non-zero on a missing script,
    // so every push would be refused with a message about formatting that never
    // ran. Loud, but wrong, and confusing enough to be answered with
    // `--no-verify`.
    expect(existsSync(path.join(repoRoot, CHECK_REL))).toBe(true);
  });

  it('takes no stdin, so no command queues for the ref pipe', () => {
    // lefthook hands git's pre-push ref list to whichever command declares
    // `use_stdin`, and two commands asking for one pipe is a queue whose loser
    // reads EOF. The `tests` command was the only consumer (DOR-116's
    // delete-only skip) and it is gone; this one wants nothing from stdin and
    // must not start.
    //
    // The KEY at its own indent, not the word: the block's comment explains why
    // the key is absent, and a substring search would read that explanation as
    // the very thing it warns against.
    expect(/^ {6}use_stdin:/m.test(prePush)).toBe(false);
  });
});

describe('the formatting check keeps the properties the gate depends on', () => {
  const checkText = readFileSync(path.join(repoRoot, CHECK_REL), 'utf8');

  it('checks rather than writes', () => {
    // The single most consequential property, and the easiest to "improve" in
    // the wrong direction the first time refusing a push is inconvenient. git
    // has already resolved the refs it is about to send by the time this hook
    // runs, so a `--write` here rewrites files that are NOT in the push: you
    // would ship the unformatted content, red the same CI check, and find a
    // dirty tree afterwards.
    expect(checkText).toContain('--list-different');
    expect(checkText).not.toMatch(/prettier_bin"?\s+--write/);
  });

  it('pins the same diff base the test gate pins', () => {
    // Two steps that disagree about "changed" is worse than one of them not
    // existing: the formatting verdict would be about a different set of files
    // than the tests, and the local `main` this expression exists to avoid
    // trails by dozens of commits on a worktree machine (DOR-833, DOR-1717).
    expect(checkText).toContain('$(git rev-parse --verify --quiet origin/main || echo main)');
  });

  it('still spells the deletion filter it keeps as belt-and-braces', () => {
    // Deletions and renames are the everyday shape of the failure this prevents:
    // prettier exits non-zero on a missing path, which would refuse honest
    // pushes. The BEHAVIOURAL guarantee — a path that is gone never reaches
    // prettier — is pinned by the fixture suite's case (d), which commits a file,
    // moves origin/main onto that commit, and only then deletes it, so the
    // deletion is a real `D` entry in the diff the script reads.
    //
    // This is only the cheap smoke that the filter has not been deleted as a
    // redundant-looking flag, and it is deliberately labelled as such, because
    // the fixture suite cannot attribute the guarantee to EITHER guard alone.
    // Measured against the corrected fixture: removing this filter leaves case
    // (d) green, removing the `[ -f ]` test behind it leaves case (d) green, and
    // removing BOTH turns it red. They shadow each other. What the filter
    // uniquely covers is the case the filesystem cannot answer — a case-only
    // rename, where the old path still tests as existing — and no honest fixture
    // can isolate that while the other guard stands. Pinning the spelling is the
    // most this file can truthfully claim.
    expect(checkText).toContain('--diff-filter=ACMRT');
  });

  it('skips symlinks the way CI skips them', () => {
    // The one place where being stricter than CI is a BUG, not a virtue.
    // Prettier refuses a symlink handed to it by name (exit 2) and skips one it
    // finds by walking a directory — and the directory walk is what
    // `prettier --check .` does in the required `lint` check. Without this guard
    // the gate hard-refuses a push over a file CI passes, while printing a
    // message saying CI is about to fail. The behavioural proof is fixture case
    // (o), which commits a real mode-120000 link and goes red when the guard is
    // removed; this pins that the line has not been tidied away as a
    // duplicate-looking neighbour of the `[ -f ]` test it must follow.
    expect(checkText).toContain('[ ! -L "$file" ] || continue');
  });

  it('tells the truth about which files are in the push', () => {
    // A single flat list asserted two falsehoods about an uncommitted file —
    // that it was "in this push" and that "CI will fail" on it — and then
    // advised committing work in progress to fix them. The split into a
    // carries-this-push bucket and a working-tree bucket is what makes every
    // sentence in the report true of the file it is printed under; fixture cases
    // (i) and (p) pin both buckets and go red in both directions when the
    // classification is forced either way.
    expect(checkText).toContain('In this push');
    expect(checkText).toContain('Uncommitted in your working tree');
    // Classified by whether the PATH is in `merge-base..HEAD`, never by whether
    // the file is dirty: a file committed unformatted and then edited again is
    // dirty AND in the push, and a dirtiness test would file it under a heading
    // saying CI cannot see it — the one error direction worth avoiding, because
    // it is a reassurance that is wrong.
    expect(checkText).toContain('"$merge_base" HEAD --');
  });

  it('never kills by name or by process group (Hard Rule 7)', () => {
    expect(checkText).not.toMatch(/\b(pkill|killall)\b/);
    expect(checkText).not.toMatch(/kill\s+(-\w+\s+)?"?-/);
  });
});
