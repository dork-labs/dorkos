/**
 * The sweep that settles interrupted marketplace installs across whole scopes.
 *
 * Every install transaction leaves a record beside its target while it runs
 * (`./install-recovery.ts` has the grammar and the rules), and settles any
 * record an earlier, interrupted transaction left before it starts. That
 * covers a target someone touches again. This sweep covers the rest: a crash
 * that left a package missing or half-written, which nobody reinstalls
 * because it simply looks gone or broken.
 *
 * It runs at server startup for the global scope before the app serves
 * anything ({@link globalSweepDirs}), and again for every registered agent's
 * project once Mesh has reconciled ({@link projectSweepDirs}) — project
 * installs live under `<projectPath>/.dork/`, which only the registry can
 * enumerate. A project that received an install but holds no registered
 * agent is not enumerable at all; its records are settled by the next install
 * or uninstall of that package there. A target left alone because another
 * process may be mid-install on it is swept once more after
 * {@link IN_FLIGHT_FLOOR_MS} ({@link retryInFlightTargetsLater}), when it is
 * settleable whoever owns it.
 *
 * The directories swept are every root a transaction writes into: the
 * package install roots (`plugins/`, `agents/`, `shapes/`) and the skills
 * roots a package's schedules are materialised into (`<dorkHome>/skills/`,
 * `<projectPath>/.agents/skills/`) — a crash-left backup of a schedule skill
 * would otherwise be one more live schedule for the task scanner to arm.
 *
 * It is one sweep over one grammar: each directory is read once (install
 * targets and their records are direct siblings, so there is nothing to walk),
 * every record found names its target, and each target is settled under that
 * target's install lock by {@link recoverInterruptedInstall}. What happens to
 * a record is decided by its kind's row in the recovery policy table, never
 * here, so a new kind of record needs no change to this file.
 *
 * Until DOR-2273 this module deleted any backup older than a day. A backup
 * that old is exactly the one a crash left when the live directory was missing
 * or half-written, so the old sweep destroyed the only good copy of the
 * install.
 *
 * @module services/marketplace/backup-janitor
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import { agentSkillsRoot, globalSkillsRoot } from '../tasks/skills-roots.js';
import { installRootsUnder, projectScopeRoot } from './lib/install-roots.js';
import {
  IN_FLIGHT_FLOOR_MS,
  keptReason,
  parseInstallRecordName,
  recoverInterruptedInstall,
  restoredAnAgent,
} from './install-recovery.js';
import { withInstallTargetLock } from './transaction.js';

/** What one sweep did, summed over every target it settled. */
export interface InstallSweepSummary {
  /** Interrupted transactions settled: a previous install restored, or a half-written one removed. */
  settled: number;
  /** Records kept, with their target, because settling them could destroy something. */
  kept: number;
  /** Leftovers of finished installs deleted. */
  discarded: number;
  /** Targets left alone because another live process may be mid-install on them. */
  inFlightTargets: string[];
  /**
   * Agent folders whose interrupted uninstall was rolled back with their
   * `agent.json` in place again (DOR-2245). Recovery runs before Mesh starts,
   * so the caller registers these agents again once it has.
   */
  restoredAgentRoots: string[];
}

/**
 * Every directory the global scope's transactions write into: the install
 * roots under `dorkHome` and the global skills root.
 *
 * @param dorkHome - The resolved data directory.
 */
export function globalSweepDirs(dorkHome: string): string[] {
  return [...installRootsUnder(dorkHome).map(({ dir }) => dir), globalSkillsRoot(dorkHome)];
}

/**
 * Every directory a project's transactions write into: the install roots
 * under `<projectPath>/.dork` and the project's skills root.
 *
 * @param projectPath - A project (or agent workspace) directory.
 */
export function projectSweepDirs(projectPath: string): string[] {
  return [
    ...installRootsUnder(projectScopeRoot(projectPath)).map(({ dir }) => dir),
    agentSkillsRoot(projectPath),
  ];
}

/**
 * The projects to sweep for a set of registered agent directories: each
 * agent's own directory and, for an agent that was installed into a project
 * (`<project>/.dork/agents/<name>`), that project too — its `.dork/` is where
 * the agent's own install records sit.
 *
 * @param agentPaths - Registered agents' project paths.
 */
export function projectsOfAgents(agentPaths: readonly string[]): string[] {
  const projects = new Set<string>();
  for (const agentPath of agentPaths) {
    projects.add(agentPath);
    const agentsDir = path.dirname(agentPath);
    const dorkDir = path.dirname(agentsDir);
    if (path.basename(agentsDir) === 'agents' && path.basename(dorkDir) === '.dork') {
      projects.add(path.dirname(dorkDir));
    }
  }
  return [...projects];
}

/**
 * Settle every interrupted install in the given directories.
 *
 * Best-effort throughout: a missing directory (nothing installed yet), an
 * unreadable one, or a target whose recovery fails is logged and skipped, so
 * one bad entry never aborts the sweep and a sweep failure never blocks server
 * startup. A target that could not be settled keeps its records and is
 * retried by the next sweep or the next install of it.
 *
 * @param dirs - Directories to sweep (see {@link globalSweepDirs} and
 *   {@link projectSweepDirs}); each is read once, not walked.
 * @param logger - Logger for what was done and what was skipped.
 * @returns Totals, and the targets left to another live process.
 */
export async function recoverInterruptedInstalls(
  dirs: readonly string[],
  logger: Logger
): Promise<InstallSweepSummary> {
  const summary: InstallSweepSummary = {
    settled: 0,
    kept: 0,
    discarded: 0,
    inFlightTargets: [],
    restoredAgentRoots: [],
  };
  for (const dir of new Set(dirs)) {
    const targets = await findTargetsWithRecords(dir, logger);
    await settleTargets(targets, summary, logger);
  }
  return summary;
}

/**
 * Sweep the targets a sweep left to another process once more, after
 * {@link IN_FLIGHT_FLOOR_MS} — by then every record there is settleable
 * whoever wrote it, so a record that belonged to a crash rather than a live
 * install does not wait for the next restart. The timer does not keep the
 * process alive.
 *
 * @param targets - {@link InstallSweepSummary.inFlightTargets} from a sweep.
 * @param logger - Logger for the retry's own results.
 * @param onDone - Receives the retry's totals.
 */
export function retryInFlightTargetsLater(
  targets: readonly string[],
  logger: Logger,
  onDone: (summary: InstallSweepSummary) => void
): void {
  if (targets.length === 0) return;
  const timer = setTimeout(() => {
    const summary: InstallSweepSummary = {
      settled: 0,
      kept: 0,
      discarded: 0,
      inFlightTargets: [],
      restoredAgentRoots: [],
    };
    settleTargets(targets, summary, logger)
      .then(() => onDone(summary))
      .catch((err: unknown) => {
        logger.warn(`[marketplace/backup-janitor] retry sweep failed: ${errMessage(err)}`);
      });
  }, IN_FLIGHT_FLOOR_MS);
  timer.unref();
}

/**
 * Every install target in `dir` that has records beside it.
 *
 * @internal
 */
async function findTargetsWithRecords(dir: string, logger: Logger): Promise<string[]> {
  let names: string[];
  try {
    names = await _internal.readNames(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[marketplace/backup-janitor] failed to read ${dir}: ${errMessage(err)}`);
    }
    return [];
  }

  const targets = new Set<string>();
  for (const name of names) {
    if (!isInstallSiblingName(name)) continue;
    const parsed = parseInstallRecordName(name);
    if (!parsed) {
      // Carries a marker but not the full grammar: not provably ours, so it
      // is hidden from readers and never touched.
      logger.warn(`[marketplace/backup-janitor] leaving unrecognised entry alone: ${name}`);
      continue;
    }
    targets.add(path.join(dir, parsed.targetName));
  }
  return [...targets];
}

/**
 * Settle each target under its install lock, adding what happened to
 * `summary`.
 *
 * @internal
 */
async function settleTargets(
  targets: readonly string[],
  summary: InstallSweepSummary,
  logger: Logger
): Promise<void> {
  for (const target of targets) {
    try {
      const report = await withInstallTargetLock(target, () => recoverInterruptedInstall(target));
      if (report.inFlight.length > 0) {
        summary.inFlightTargets.push(target);
        logger.info(
          `[marketplace/backup-janitor] left ${target} alone: another DorkOS app may be installing it right now`
        );
        continue;
      }
      for (const { record, outcome } of report.settled) {
        summary.settled++;
        logger.info(
          `[marketplace/backup-janitor] settled an interrupted install at ${target} (${record.kind}: ${outcome})`
        );
      }
      if (await restoredAnAgent(target, report)) summary.restoredAgentRoots.push(target);
      for (const record of report.kept) {
        summary.kept++;
        logger.warn(
          `[marketplace/backup-janitor] kept ${record.path} and ${target} as they are: ${keptReason(record)}; the next install or uninstall of it removes the record`
        );
      }
      summary.discarded += report.discarded.length;
      for (const { record, error } of report.discardFailures) {
        logger.warn(
          `[marketplace/backup-janitor] failed to remove finished install leftovers ${record.path}: ${errMessage(error)}`
        );
      }
    } catch (err) {
      logger.warn(
        `[marketplace/backup-janitor] could not settle the interrupted install at ${target}; it will be retried: ${errMessage(err)}`
      );
    }
  }
}

/**
 * Render an unknown caught value as a log-friendly message.
 *
 * @internal
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * List a directory's entry names.
 *
 * @internal
 */
async function readNames(dir: string): Promise<string[]> {
  return readdir(dir);
}

/**
 * @internal Test-only export. The supported API is
 * {@link recoverInterruptedInstalls}; this is exposed only so tests can fail a
 * directory read with `vi.spyOn` — mirrors the `_internal` pattern in
 * `./transaction.ts`, which sidesteps the "cannot spy on a `node:fs/promises`
 * named export" ESM limitation.
 */
export const _internal = {
  readNames,
};
