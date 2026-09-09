/**
 * What a global plan gets on THIS machine: the two decisions somebody recorded,
 * and the directories they imply.
 *
 * The engine takes its roots injected and resolves no home directory of its own
 * (`packages/harness/src/plan/global-projector.ts`). This is the module that
 * resolves them, and it is the only place the two answers are joined:
 *
 * - `harness.global` — which agent tools to share with, and whether the question
 *   has been asked, read from `~/.dork/config.json`.
 * - `boundaryWasConfigured` — whether somebody confined this deployment, in
 *   which case the user tier is skipped and the sentence saying so is returned
 *   rather than printed here.
 *
 * **It never opens a `conf` store.** `dorkos harness sync --check` is documented
 * as writing nothing (DOR-678), and `conf`'s constructor creates the directory
 * and writes `config.json` when either is missing — measured, not assumed — so a
 * check run from the wrong folder would plant a `~/.dork` there. The file is
 * parsed directly with the same Zod schema the server uses, exactly as
 * `hook-consent.ts` does for the same reason and under the same rule: the two
 * must agree, so they parse one schema.
 *
 * **It resolves both roots even when nothing is enabled.** The roots say where
 * DorkOS MAY write and the harness list says whether anybody asked it to; the
 * planner needs both, and collapsing them would make each mean the other. The
 * one thing that removes a root is a configured boundary.
 *
 * @module services/harness/global-scope
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalPlanRoots } from '@dorkos/harness';
import type { HarnessId } from '@dorkos/shared/harness-schemas';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { boundaryWasConfigured, type BoundaryConfigReader } from '../../lib/boundary.js';
import { inheritedClaudeRoot } from '../runtimes/claude-code/claude-config-dir.js';
import { agentsUserSkillsDir } from './agents-user-home.js';

/** The two decisions `harness.global` records, as read off disk. */
export interface GlobalSharingAnswer {
  /** The agent tools DorkOS shares globally installed packages with. */
  harnesses: readonly HarnessId[];
  /** When the question was answered, ISO-8601, or `null` if it never has been. */
  askedAt: string | null;
  /**
   * Why the answer is empty because the FILE could not be read, when that is
   * what happened.
   *
   * A missing `config.json` is a fresh install and leaves this absent: nothing
   * has been decided, and "nothing decided" is the truth. A truncated or
   * schema-invalid one is a different thing, and a run that is about to write
   * into somebody's home directory may not treat the two the same way.
   */
  unreadable?: string;
}

/** The answer a fresh install gives: nothing shared, nothing asked. */
const NOTHING_SHARED: GlobalSharingAnswer = { harnesses: [], askedAt: null };

/**
 * Read `harness.global` without opening (or creating) the config store.
 *
 * @param dorkHome - the resolved DorkOS data directory.
 * @returns the recorded answer, or the fresh-install one with a reason attached
 *   when the file exists and could not be understood.
 */
export function readGlobalSharingFromDisk(dorkHome: string): GlobalSharingAnswer {
  let text: string;
  try {
    text = readFileSync(join(dorkHome, 'config.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NOTHING_SHARED;
    return { ...NOTHING_SHARED, unreadable: describeReadFailure(err) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ...NOTHING_SHARED, unreadable: describeReadFailure(err) };
  }

  const stored = (raw as { harness?: unknown } | null)?.harness;
  const parsed = UserConfigSchema.shape.harness.safeParse(stored);
  if (!parsed.success) {
    return {
      ...NOTHING_SHARED,
      unreadable: `the "harness" settings are not in a shape DorkOS understands (${parsed.error.issues[0]?.message ?? 'invalid'})`,
    };
  }
  return { harnesses: parsed.data.global.harnesses, askedAt: parsed.data.global.askedAt };
}

/** One short clause naming what went wrong, for a message a person reads. */
function describeReadFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Everything a caller needs to build a global plan and report on it honestly. */
export interface GlobalScopeInputs {
  /** The roots to hand the planner. Both user roots are absent under a boundary. */
  roots: GlobalPlanRoots;
  /** The agent tools recorded in `harness.global.harnesses`. */
  harnesses: readonly HarnessId[];
  /** When the sharing question was answered, or `null` if it never has been. */
  askedAt: string | null;
  /**
   * The configured boundary root, present only when one was configured and the
   * user tier was therefore skipped.
   *
   * Returned rather than printed: this module resolves, and the CLI and the
   * status surface each say it in their own voice.
   */
  boundaryRoot?: string;
  /** Why the recorded answer could not be read, when that is what happened. */
  unreadableConfig?: string;
}

/**
 * Resolve everything a global plan needs on this machine.
 *
 * The Claude Code target is `path.join(inheritedClaudeRoot(), 'skills')`, ONE
 * directory: that is the root a bare `claude` opens, and a bare `claude` is the
 * only Claude Code the user tier has to serve, because a DorkOS-driven session
 * is served whole by SDK injection on any account (spec §2.9).
 * `resolveActiveClaudeRoot()` is not used — it answers which account DorkOS
 * bills — and `resolveClaudeRootSet()` is not used either, because writing links
 * into every registered account would put files in accounts nobody is running.
 *
 * @param dorkHome - the resolved DorkOS data directory.
 * @param env - the process environment, for the boundary check.
 * @param config - the config store the boundary check reads `server.boundary`
 *   from. It is a separate argument from `dorkHome` because the CLI reads the
 *   file and the server reads its manager, and neither may be assumed here.
 * @returns the roots, the recorded answer, and the boundary root when one
 *   confined this deployment.
 */
export function resolveGlobalScopeInputs(
  dorkHome: string,
  env: NodeJS.ProcessEnv,
  config: BoundaryConfigReader
): GlobalScopeInputs {
  const answer = readGlobalSharingFromDisk(dorkHome);
  const base = {
    harnesses: answer.harnesses,
    askedAt: answer.askedAt,
    ...(answer.unreadable === undefined ? {} : { unreadableConfig: answer.unreadable }),
  };

  if (boundaryWasConfigured(env, config)) {
    // A boundary limits how far DorkOS reaches into a person's disk, and
    // `<dorkHome>` is DorkOS's own directory, which every deployment already
    // writes to on every boot. So the dork-home tier is unaffected and the user
    // tier is simply not given a root — which is also why nothing under a home
    // directory is READ here, let alone removed.
    //
    // `validateBoundaryOrDorkHome` is deliberately never called: it narrows to
    // `<dorkHome>/agents/*` on purpose, so reaching for it would either refuse
    // the write or invite somebody to widen a security narrowing to make a
    // feature work.
    const configured = env.DORKOS_BOUNDARY?.trim() || String(config.getDot('server.boundary'));
    return { ...base, roots: { dorkHome }, boundaryRoot: configured };
  }

  return {
    ...base,
    roots: {
      dorkHome,
      agentsSkillsDir: agentsUserSkillsDir(),
      claudeSkillsDir: join(inheritedClaudeRoot(), 'skills'),
    },
  };
}
