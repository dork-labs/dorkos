/**
 * `pnpm check`: the gate ladder in one place (DOR-4947).
 *
 * With no stage it prints every rung a change climbs, from an edit to the merge
 * queue, and what each one runs. With a stage it runs that rung's own command,
 * unchanged, and exits with its code. The two CI rungs can't run here: naming one
 * prints the required checks it reports and exits 2.
 *
 *   pnpm check            # print the ladder
 *   pnpm check <stage>    # run one rung: edit, commit, push, preopen or verify
 *
 * @module scripts/check/cli
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** One rung of the ladder. */
export interface Stage {
  /** What you type after `pnpm check`. */
  readonly name: string;
  /** When it runs without being asked. */
  readonly when: string;
  /** What it runs, in a few words. */
  readonly runs: string;
  /** The command `pnpm check <name>` runs, from the repo root; absent for a CI rung. */
  readonly command?: readonly string[];
}

/** The ladder, lowest rung first. */
export const LADDER: readonly Stage[] = [
  {
    name: 'edit',
    when: 'at the end of each agent turn (Stop hook)',
    runs: 'prettier and Tailwind class sorting on the files this checkout changed',
    command: ['bash', '.claude/hooks/format-changed.sh'],
  },
  {
    name: 'commit',
    when: 'git commit (lefthook pre-commit)',
    runs: 'prettier on staged files, lint of affected packages, the fast file checks',
    command: ['pnpm', 'exec', 'lefthook', 'run', 'pre-commit'],
  },
  {
    name: 'push',
    when: 'git push (lefthook pre-push)',
    runs: 'the formatting check, the ratchets and the other push checks',
    command: ['pnpm', 'exec', 'lefthook', 'run', 'pre-push'],
  },
  {
    name: 'preopen',
    when: 'never on its own; optional, for debugging before a PR',
    runs: 'the scripts suites in scope, typecheck and lint of affected packages; no package tests',
    command: ['node', 'scripts/verify-proof/cli.ts', 'run-preopen'],
  },
  {
    name: 'verify',
    when: 'never on its own; optional, the full local check',
    runs: 'the scripts suites, root lint, then typecheck, lint and tests of affected packages',
    command: ['node', 'scripts/verify-proof/cli.ts', 'run'],
  },
  {
    name: 'pr',
    when: 'CI, on every pull request',
    runs: 'the required checks in ci/required-checks.json',
  },
  {
    name: 'queue',
    when: 'CI, in the merge queue',
    runs: 'the same required checks, on merge_group; then the PR merges',
  },
];

/** The ladder as text: one block per rung, the CI rungs naming the required checks. */
export function ladderText(requiredChecks: readonly string[]): string {
  const width = Math.max(...LADDER.map((stage) => stage.name.length));
  const lines = ['The gate ladder, lowest rung first. Run one: pnpm check <stage>', ''];
  for (const stage of LADDER) {
    lines.push(`  ${stage.name.padEnd(width)}  ${stage.when}`);
    lines.push(`  ${''.padEnd(width)}  runs: ${stage.runs}`);
    if (stage.command) lines.push(`  ${''.padEnd(width)}  command: ${stage.command.join(' ')}`);
  }
  lines.push('', `Required checks (pr and queue): ${requiredChecks.join(', ')}`);
  lines.push('Only CI judges a PR; every local rung is optional past push (contributing/ci.md).');
  return lines.join('\n');
}

/** The required checks CI reports on the pr and queue rungs. */
export function readRequiredChecks(root: string): string[] {
  const file = path.join(root, 'ci/required-checks.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { contexts?: unknown };
  return Array.isArray(parsed.contexts) ? parsed.contexts.map(String) : [];
}

/**
 * What `pnpm check` does with these arguments: print the ladder, run a rung, or
 * refuse with a reason and an exit code.
 */
export function plan(
  args: readonly string[]
):
  | { kind: 'ladder' }
  | { kind: 'run'; stage: Stage & { command: readonly string[] } }
  | { kind: 'refuse'; why: string; code: number } {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h')))
    return { kind: 'ladder' };
  const [name, ...rest] = args;
  const stage = LADDER.find((candidate) => candidate.name === name);
  if (!stage)
    return {
      kind: 'refuse',
      why: `pnpm check: no stage "${name}". Stages: ${LADDER.map((s) => s.name).join(', ')}`,
      code: 2,
    };
  // A rung is the gate as it stands; a flag would make it a different one.
  if (rest.length > 0)
    return {
      kind: 'refuse',
      why: `pnpm check ${stage.name} takes no arguments (got: ${rest.join(' ')})`,
      code: 2,
    };
  if (!stage.command)
    return {
      kind: 'refuse',
      why: `pnpm check ${stage.name}: ${stage.when}, so it can't run here. It runs ${stage.runs}; see gh pr checks.`,
      code: 2,
    };
  return { kind: 'run', stage: { ...stage, command: stage.command } };
}

/** node resolves symlinks for import.meta.url but not argv, so compare real paths. */
function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === path.resolve(import.meta.filename);
}

if (isMain()) {
  const root = path.resolve(import.meta.dirname, '../..');
  const decided = plan(process.argv.slice(2));
  if (decided.kind === 'ladder') {
    console.log(ladderText(readRequiredChecks(root)));
  } else if (decided.kind === 'refuse') {
    console.error(decided.why);
    process.exitCode = decided.code;
  } else {
    const [command, ...commandArgs] = decided.stage.command;
    const result = spawnSync(command!, commandArgs, { cwd: root, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
}
