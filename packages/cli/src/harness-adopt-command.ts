/**
 * `dorkos harness adopt` — move one skill an agent wrote in a tool's own folder
 * into `.agents/skills`, where every agent reads it.
 *
 * One skill, by name, on purpose. There is no multi-adopt and no bare
 * `dorkos harness adopt` that acts: moving files a person wrote is not something
 * a command should do to a folder full of them because somebody pressed return
 * (D3), and the exposure is one-way — five tools read `.agents/skills` the
 * instant the directory lands there.
 *
 * **`--check` exits 0 when the move WOULD succeed, which is the opposite of
 * `sync --check`.** They ask different questions: `sync --check` asks "is my tree
 * in sync?", so work outstanding is a non-zero answer, while
 * `adopt <name> --check` asks "will this command work?", so success is zero and a
 * refusal is one. It is stated in the help text and in
 * `contributing/harness-sync.md` because it is exactly the kind of thing a script
 * author trips over once and never forgives.
 *
 * Like every other command handler in this package it returns an exit code and
 * never calls `process.exit`.
 *
 * @module harness-adopt-command
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { rethrowUnknownOption } from './lib/parse-args-error.js';
import { wantsDebugDetail } from './lib/debug-detail.js';

import {
  ADOPT_TARGET_ROOT,
  HARNESS_MANIFEST_PATH,
  applyAdopt,
  inventorySourceTree,
  loadManifest,
  planAdopt,
  readAdoptCandidates,
  type AdoptMove,
  type AdoptPlan,
} from '@dorkos/harness';

/** Parsed arguments accepted by {@link runHarnessAdopt}. */
export interface HarnessAdoptArgs {
  /** The skill to move, by its folder name. */
  name: string;
  /** The project to act on, as typed. Absent means the folder you are in. */
  project?: string;
  /** Record the skill as Claude-Code-only instead of moving it. */
  claudeOnly: boolean;
  /** Say what would happen, and write nothing. */
  check: boolean;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos harness adopt <name> [--project <path>] [--claude-only] [--check]';

/** What to run instead when the command was given no skill to move. */
const LIST_COMMAND = 'dorkos harness sync --check';

/**
 * Parse raw CLI arguments for `dorkos harness adopt`.
 *
 * One positional and exactly one: `allowPositionals: true`, unlike
 * `parseHarnessSyncArgs`, which takes none. A bare `dorkos harness adopt` is a
 * usage error naming the command that lists candidates rather than doing
 * something, because a bare adopt that acted would be one keystroke away from
 * the multi-adopt this work deliberately does not ship.
 *
 * @param rawArgs - raw argv slice that comes after `harness adopt`.
 * @returns the parsed arguments.
 * @throws When a flag is unknown, no skill was named, or more than one was.
 */
export function parseHarnessAdoptArgs(rawArgs: string[]): HarnessAdoptArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        'claude-only': { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'harness adopt', USAGE_LINE);
  }

  const { values, positionals } = parsed;
  if (positionals.length === 0) {
    throw new Error(
      `Name the skill you want to move.\n${USAGE_LINE}\n  Run \`${LIST_COMMAND}\` to see which skills only some of your agents can read.`
    );
  }
  if (positionals.length > 1) {
    throw new Error(
      `Adopt moves one skill at a time, and you named ${positionals.length}: ${positionals.join(', ')}.\n${USAGE_LINE}`
    );
  }

  return {
    name: positionals[0] as string,
    ...(typeof values.project === 'string' ? { project: values.project } : {}),
    claudeOnly: Boolean(values['claude-only']),
    check: Boolean(values.check),
  };
}

/**
 * Implements `dorkos harness adopt` — drives the `@dorkos/harness` adopt engine
 * entirely offline.
 *
 * @param args - parsed {@link HarnessAdoptArgs}.
 * @returns an object carrying the process exit code.
 */
export async function runHarnessAdopt(args: HarnessAdoptArgs): Promise<{ exitCode: number }> {
  // Resolved against the CLI's OWN cwd. Adopt never reaches a server, so the
  // `--project .` hazard DOR-1921 measured does not exist for the command
  // itself — but every string DorkOS prints still carries the absolute root.
  const repoRoot =
    args.project === undefined ? process.cwd() : resolve(process.cwd(), args.project);

  if (!existsSync(join(repoRoot, HARNESS_MANIFEST_PATH))) {
    // The same answer `sync --check` gives, and for the same reason: a missing
    // manifest usually means the command is pointed at the wrong folder, and a
    // person asking to move one skill has not asked DorkOS to set the project up.
    console.error(`No harness manifest in ${repoRoot}`);
    console.error(`  looked for: ${HARNESS_MANIFEST_PATH}`);
    console.error('');
    console.error(
      'Adopt moves a skill inside a project DorkOS already shares files for, and it never sets one up.'
    );
    console.error(
      'Run it again from your project root, or create a manifest there with `dorkos harness sync --fix`.'
    );
    return { exitCode: 1 };
  }

  try {
    const manifest = loadManifest(repoRoot);
    const read = readAdoptCandidates(repoRoot, inventorySourceTree(repoRoot), manifest);
    const plan = planAdopt({
      ...read,
      request: {
        mode: 'explicit',
        name: args.name,
        ...(args.claudeOnly ? { claudeOnly: true } : {}),
      },
      // A person at a terminal in a folder they chose. The two other ownerships
      // are the server's to establish — it is the one that knows which folders
      // are agent homes and room worktrees — and they arrive with the boot path.
      ownership: 'plain',
    });

    if (plan.blocked !== undefined) {
      console.log(plan.blocked.reason);
      return { exitCode: 1 };
    }
    return { exitCode: args.check ? reportWouldHappen(plan) : carryOut(repoRoot, plan) };
  } catch (err) {
    // The same three lines `dorkos harness sync` prints, because it is the same
    // person in the same folder with the same unreadable file: the sentence, the
    // folder it happened in — a person who passed `--project` is not standing
    // there — and the way to the stack rather than the stack itself.
    console.error(`Harness adopt failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  in ${repoRoot}`);
    if (err instanceof Error && err.stack && wantsDebugDetail()) console.error(err.stack);
    else console.error('  Re-run with LOG_LEVEL=debug to see the stack.');
    return { exitCode: 1 };
  }
}

/**
 * `--check`: say what would happen, and write nothing.
 *
 * @param plan - what the run would do.
 * @returns `0` when it would move or record the skill, `1` when it is refused.
 */
function reportWouldHappen(plan: AdoptPlan): number {
  for (const move of plan.moves) {
    console.log(
      move.link === undefined
        ? `Would move ${move.from} to ${move.to}, where every agent reads it.`
        : `Would move ${move.from} to ${move.to}, and leave a link at ${move.link.target} so Claude Code still finds it.`
    );
  }
  for (const declaration of plan.declarations) {
    console.log(
      `Would record ${declaration.name} as belonging to Claude Code. It stays in ${declaration.path}.`
    );
  }
  for (const refusal of plan.refusals) console.log(refusal.reason);
  console.log('');
  console.log('--check wrote nothing.');
  return plan.refusals.length > 0 ? 1 : 0;
}

/**
 * Carry the plan out and say what happened.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - what the run decided.
 * @returns `0` when the skill moved or was recorded, `1` when it was refused.
 */
function carryOut(repoRoot: string, plan: AdoptPlan): number {
  const result = applyAdopt(repoRoot, plan);
  for (const move of result.moved) console.log(movedSentence(move));
  for (const declaration of result.declared) {
    console.log(
      `Recorded ${declaration.name} as belonging to Claude Code. It stays in ${declaration.path}, ` +
        `and your other agents are told why they don't get it.`
    );
  }
  for (const refusal of result.refusals) console.log(refusal.reason);
  return result.moved.length + result.declared.length > 0 ? 0 : 1;
}

/**
 * What one landed move says (S15, and S15b when no link was left).
 *
 * The variant is chosen by the presence of the link itself, and the path it
 * names is the LINK's own target rather than the folder the skill came out of —
 * a skill adopted out of `.opencode/skills` is still found by Claude Code at
 * `.claude/skills/<name>`, and naming the old folder there would send a person
 * to look in a directory the link is not in.
 *
 * @param move - the move that landed.
 * @returns the sentence to print.
 */
function movedSentence(move: AdoptMove): string {
  return move.link?.target === undefined
    ? `Moved ${move.name} to ${ADOPT_TARGET_ROOT}/${move.name}, where every agent reads it.`
    : `Moved ${move.name} to ${ADOPT_TARGET_ROOT}/${move.name}. Claude Code still finds it through a link at ${move.link.target}.`;
}
