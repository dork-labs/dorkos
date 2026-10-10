/**
 * How `dorkos config` writes.
 *
 * Split out of `config-commands.ts` because it is a different job: that file
 * routes subcommands and formats what they print, while this one owns the seam
 * to the server's guarded write.
 *
 * @module config-write
 */
import path from 'path';
// Types only — erased before the bundle, and resolved for tsc by the
// declaration mirror in `packages/cli/server/`.
import type { GuardedConfigWriteResult } from '../server/services/core/operator/config-write.js';

/**
 * The refusal code for a permissions key sent through `dorkos config set`, as a
 * literal: the constant lives in the server bundle, which this file only reaches
 * through a specifier esbuild rewrites at bundle time. Pinned by value in `apps/server/src/services/core/operator/__tests__/config-write.test.ts`.
 */
export const USE_PERMISSIONS_API_CODE = 'USE_PERMISSIONS_API';

/**
 * How `dorkos config` reaches the server's config-write code.
 *
 * A seam, not indirection for its own sake: the function it wraps lives in the
 * server bundle, which the CLI reaches through a specifier that only resolves
 * once esbuild has rewritten it (`packages/cli/server/**.d.ts` explains the
 * arrangement). A test running from source cannot resolve it at all, so the
 * dependency is passed in and {@link createServerConfigWriter} builds the
 * production one.
 */
export interface CliConfigWriter {
  /**
   * Write through the same guarded step `PATCH /api/config` uses: the write
   * policy and the audit line.
   *
   * @param patch - The partial config to merge.
   * @param source - How this write should read in the audit line.
   */
  guarded(patch: Record<string, unknown>, source: string): Promise<GuardedConfigWriteResult>;
}

/**
 * Point the server's logger at this data directory, so the write about to happen
 * leaves its line in the same `~/.dork/logs/dorkos.log` the server writes to.
 *
 * ## Best-effort, and only on a WRITE (DOR-1247)
 *
 * Both halves are load-bearing, and both are fixes for one defect found in
 * review.
 *
 * **Only on a write.** This used to run for every `dorkos config` subcommand,
 * from inside `openConfigStore`. `initLogger` calls `mkdirSync(logDir)`, so
 * `dorkos config get` — the command somebody runs BECAUSE their install is
 * broken — died with a raw `EACCES` stack on any data directory it could not
 * write to, which is the normal shape of a root-owned `~/.dork` volume in the
 * Docker deployment. A pure read also has no business creating a `logs/`
 * directory as a side effect.
 *
 * **Best-effort.** A log DorkOS cannot open must never be the reason a setting
 * cannot be changed. A failure here degrades to one plain warning and the write
 * goes ahead unrecorded — worse than being recorded, far better than refusing a
 * person their own settings.
 *
 * @param dorkHome - The resolved data directory.
 * @param level - The operator's own `logging.level`, already a number.
 */
async function openAuditLog(dorkHome: string, level: number): Promise<void> {
  const logDir = path.join(dorkHome, 'logs');
  try {
    const { initLogger } = await import('../server/lib/logger.js');
    initLogger({ logDir, level });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠  Could not open the log at ${logDir}, so this change will not be recorded there: ${reason}`
    );
  }
}

/**
 * The production writer: the server's own guarded step, under the operator's own
 * identity.
 *
 * `LOCAL_OPERATOR_AUTHORITY` carries the reasoning for that identity — briefly,
 * a person at their own terminal is the same trust the cockpit has in the
 * default posture, and the consent door still applies to them.
 *
 * The specifier is written out in full rather than held in a constant. A dynamic
 * import whose specifier is a VARIABLE is invisible to every mechanism that keeps
 * this working — esbuild cannot rewrite it, tsc cannot resolve it, and
 * `__tests__/server-shims.test.ts` cannot see it — so it would survive the build
 * and only fail at a user's install.
 *
 * @param dorkHome - The resolved data directory, for the audit log.
 * @param logLevel - The operator's own `logging.level` as a number.
 * @returns The writer to hand {@link handleConfigCommand}.
 */
export function createServerConfigWriter(dorkHome: string, logLevel: number): CliConfigWriter {
  return {
    async guarded(patch, source) {
      await openAuditLog(dorkHome, logLevel);
      const { applyGuardedConfigWrite, LOCAL_OPERATOR_AUTHORITY } =
        await import('../server/services/core/operator/config-write.js');
      return applyGuardedConfigWrite({
        patch,
        authority: LOCAL_OPERATOR_AUTHORITY,
        source,
        // The terminal clears every AUTHORITY bar (that is the argument above),
        // and still cannot say who typed the command — a script an agent wrote
        // runs in the same shell. Authority and attribution are different
        // questions, and only the first one the terminal can answer. See
        // `display-name-provenance.ts`.
        writer: { kind: 'unattributed' },
      });
    },
  };
}

/**
 * Run a guarded write, and turn a filesystem refusal into one plain line.
 *
 * The guarded write answers "may I, and is this valid" with a typed result, and
 * a refusal from either is already handled by the caller. What it cannot answer
 * is the operating system saying no: `conf` writes through a temp file beside
 * `config.json`, so a data directory that is readable but not writable throws an
 * `EACCES` from deep inside the store and sprayed a stack over the terminal.
 *
 * That is the other half of the same defect the read path had (DOR-1247), and it
 * is reached by exactly the person the read-path warning has just told that
 * saving will not work — so it must not be the one message that is a stack
 * trace.
 *
 * @param writer - The writer to run.
 * @param patch - The partial config to merge.
 * @param source - How the write should read in the audit line.
 * @returns The guarded write's result. Exits the process on a refusal by the
 *   filesystem, which is not something a caller can do anything about.
 */
export async function writeOrExplain(
  writer: CliConfigWriter,
  patch: Record<string, unknown>,
  source: string
): Promise<GuardedConfigWriteResult> {
  try {
    return await writer.guarded(patch, source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`DorkOS could not save your settings: ${reason}`);
    console.error('Check that you can write to your DorkOS folder, then try again.');
    process.exit(1);
  }
}
