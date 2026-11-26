/**
 * Every ratchet in the repo: a count held in a committed baseline file that may
 * only fall (DOR-4948). `pnpm ratchet` (scripts/ratchets/ratchet.ts) runs them all and
 * prints one summary; `pnpm ratchet --help` says how.
 *
 * Each ratchet keeps its own script and its own baseline file. This list only
 * names them, so one command can run them, CI and pre-push call that command,
 * and a person reading a red line knows who keeps it and what lowers it. It
 * holds no dates: a ratchet falls as the work that lowers it lands, not by a
 * deadline.
 *
 * Not to be confused with `ci/ratchets.yaml`, which is CI Steward's list of
 * pipeline counts (tests passed, required contexts) held against high-water
 * marks on the data branch, not files in the tree.
 *
 * WHICH FILES ARE BASELINES. A file named `baseline.json`, `<x>-baseline.json`
 * or `<x>.baseline.json` under `scripts/` or `apps/server/eslint-rules/`
 * ({@link BASELINE_DIRS}, {@link isBaselineName}). Every one must be listed
 * here, and every file listed here must exist:
 * `scripts/__tests__/ratchets.test.ts` holds both. Other files called
 * "baseline" elsewhere are snapshots a test compares against (route census,
 * screenshot and schema baselines), not counts that fall, and
 * `apps/client/eslint-rules/barrel.baseline.json` is held by the client's lint
 * and `cross-slice-import-lint.test.ts`, with no script of its own to call.
 *
 * @module scripts/ratchets/registry
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One ratchet: its script, its baseline files, and who keeps it. */
export interface Ratchet {
  /**
   * Its name: the `pnpm check:<name>` script it is, and the word its own
   * output lines start with (`max-lines: clean. ...`).
   */
  name: string;
  /** The script `pnpm check:<name>` runs with `node`, from the repo root. */
  script: string;
  /** Its baseline files, from the repo root. */
  baselines: string[];
  /**
   * The role that keeps it: the one to ask about a red nobody understands, and
   * the one who agrees to a one-off raise. A role, never a person.
   */
  owner: string;
  /** The ticket whose work lowers it, or `none yet`. */
  takenDownBy: string;
  /** Why it is reported but never fails `pnpm ratchet`. Absent: a failure fails. */
  advisory?: string;
  /**
   * Why it needs the workspace packages built. Absent: it reads files only.
   * Without a build such a ratchet cannot measure; CI runs it after one.
   */
  needsBuild?: string;
  /** Whether pre-push runs it (`pnpm ratchet --pre-push`). */
  prePush: boolean;
  /** Whether it takes `--queue`, which `pnpm ratchet --queue` passes on in the merge queue. */
  queue?: boolean;
}

/** The folders searched for baseline files, from the repo root. */
export const BASELINE_DIRS = ['scripts', 'apps/server/eslint-rules'] as const;

/** Whether a file name is a ratchet baseline's: `baseline.json`, `x-baseline.json`, `x.baseline.json`. */
export function isBaselineName(name: string): boolean {
  return /(?:^|[.-])baseline\.json$/.test(name);
}

/** Every baseline file under {@link BASELINE_DIRS}, from `root`, sorted. */
export function findBaselines(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (isBaselineName(entry.name)) found.push(path);
    }
  };
  for (const dir of BASELINE_DIRS) walk(dir);
  return found.sort();
}

/**
 * What is wrong between the baseline files under `root` and a registry: a
 * baseline no ratchet lists, and a listed file or script that is not there.
 * Empty when they agree.
 */
export function registryProblems(root: string, ratchets: readonly Ratchet[]): string[] {
  const listed = new Set(ratchets.flatMap((r) => r.baselines));
  const problems = findBaselines(root)
    .filter((file) => !listed.has(file))
    .map((file) => `${file} is a baseline no ratchet in scripts/ratchets/registry.ts lists`);
  for (const r of ratchets) {
    for (const file of [r.script, ...r.baselines]) {
      if (!existsSync(join(root, file)))
        problems.push(`${r.name} names ${file}, which is not there`);
    }
  }
  return problems;
}

/** Every ratchet, in the order `pnpm ratchet` prints them. */
export const RATCHETS: readonly Ratchet[] = [
  {
    name: 'max-lines',
    script: 'scripts/check-max-lines.ts',
    baselines: ['scripts/max-lines/baseline.json', 'scripts/max-lines/test-baseline.json'],
    // Splitting large files is codebase structure; no ticket splits them yet.
    owner: 'architecture',
    takenDownBy: 'none yet',
    prePush: true,
  },
  {
    name: 'own-mocks',
    script: 'scripts/check-own-mocks.ts',
    baselines: ['scripts/own-mocks/baseline.json'],
    // Test quality: .claude/rules/testing.md, the pruning-tests skill.
    owner: 'qa',
    takenDownBy: 'none yet',
    prePush: true,
  },
  {
    name: 'test-ratio',
    script: 'scripts/test-ratio/check-test-ratio.ts',
    baselines: ['scripts/test-ratio/baseline.json'],
    // Test quality, as own-mocks; lowered by each pruning-tests pass.
    owner: 'qa',
    takenDownBy: 'none yet',
    prePush: true,
  },
  {
    name: 'turn-port',
    script: 'scripts/turn-port/check-turn-port-boundary.ts',
    baselines: ['apps/server/eslint-rules/turn-port-boundary.baseline.json'],
    // Every space-side caller moves to the turn port (spec turns-survive-restarts).
    owner: 'architecture',
    takenDownBy: 'DOR-5157',
    prePush: true,
  },
  {
    name: 'computer-wall',
    script: 'scripts/computer-wall/check-computer-wall.ts',
    baselines: ['apps/server/eslint-rules/computer-wall.baseline.json'],
    // The seam steps C2 to C23 of spec computer-side-starts-alone, under its epic.
    owner: 'architecture',
    takenDownBy: 'DOR-5152',
    prePush: true,
  },
  {
    name: 'import-boundary',
    script: 'scripts/import-boundary/check-import-boundary.ts',
    baselines: ['apps/server/eslint-rules/import-boundary.baseline.json'],
    owner: 'architecture',
    takenDownBy: 'none yet',
    prePush: true,
  },
  {
    name: 'design-tokens',
    script: 'scripts/check-design-tokens.ts',
    baselines: ['scripts/design-tokens/baseline.json'],
    owner: 'design-system',
    takenDownBy: 'none yet',
    // Its `--base` refuses a changed rule unless the PR carries a fresh
    // `guard-rule-change` label, and before the push there is no PR to label.
    prePush: false,
  },
  {
    name: 'api-lint',
    script: 'scripts/api-lint/check-api-lint.ts',
    baselines: ['scripts/api-lint/baseline.json'],
    // Old routes move to the new shape area by area.
    owner: 'API lead',
    takenDownBy: 'DOR-4977',
    // Never ran at pre-push; CI only, so this change moves nothing there.
    prePush: false,
    queue: true,
  },
  {
    name: 'knip',
    script: 'scripts/check-knip.ts',
    baselines: ['scripts/knip/baseline.json'],
    // The dead-code lane of the codebase cleanup.
    owner: 'architecture',
    takenDownBy: 'DOR-4186',
    advisory: 'reported, never failing, until DOR-4629 decides whether knip may fail CI',
    needsBuild:
      'knip loads every workspace config, and those import built package output; it then reads the whole monorepo',
    prePush: false,
  },
];
