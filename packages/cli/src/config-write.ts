/**
 * How `dorkos config` writes, and the consent ritual that guards the one setting
 * a person must be told about before they choose it.
 *
 * Split out of `config-commands.ts` because it is a different job: that file
 * routes subcommands and formats what they print, while this one owns the seam
 * to the server's guarded write and the terminal's version of the cockpit's
 * consent dialog.
 *
 * @module config-write
 */
import path from 'path';
// Types only — erased before the bundle, and resolved for tsc by the
// declaration mirror in `packages/cli/server/`.
import type { GuardedConfigWriteResult } from '../server/services/core/operator/config-write.js';
import type { ConfigStore } from './config-commands.js';

/**
 * The refusal code the Full-autonomy consent door answers with, as a literal.
 *
 * It cannot be imported: the constant lives in the server bundle, which this
 * file only reaches through a specifier esbuild rewrites at bundle time, and a
 * value import would have to be awaited inside the refusal path. So it is
 * duplicated here — the same way the cockpit duplicates it (`ChatStatusSection`)
 * — and pinned by value in
 * `apps/server/src/services/core/approvals/__tests__/autonomy-consent.test.ts`,
 * which names both copies.
 */
export const AUTONOMY_ACK_REQUIRED_CODE = 'AUTONOMY_ACK_REQUIRED';

/** The command that gives the terminal the acknowledgement the door asks for. */
export const ACKNOWLEDGE_AUTONOMY_COMMAND = 'dorkos config acknowledge-autonomy';

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
   * policy, the Full-autonomy consent door, and the audit line.
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
      return applyGuardedConfigWrite({ patch, authority: LOCAL_OPERATOR_AUTHORITY, source });
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

/**
 * What a person reads before they agree to start every new session in Full
 * autonomy.
 *
 * The wording tracks the cockpit's own consent dialog rather than inventing a
 * second version: the middle paragraph is the scope note the dialog renders
 * verbatim (`permission-mode-scope-note.tsx`), because a person who reads one
 * sentence in the app and a different one in a terminal has been told two
 * things about one setting.
 *
 * What it deliberately does NOT copy is the per-runtime promise the dialog puts
 * at the top. That sentence comes off a runtime's own profile, which a terminal
 * with no server cannot read — a stand-in would be wrong for somebody's agent.
 */
const AUTONOMY_CONSENT_TEXT = [
  'Starting every new session in Full autonomy means your agents stop asking first.',
  '',
  'A session that starts this way runs its tools without showing you an approval',
  'card — no pause, no chance to say no, for every new session from now on until',
  'you change it back.',
  '',
  'This covers tools inside the session. Actions on DorkOS itself, like removing',
  'packages, still ask.',
  '',
  'DorkOS records that you agreed, with today’s date, so it stops asking you this.',
  'You can take that back at any time in Settings, or with',
  '`dorkos config set ui.autonomyAcknowledgedAt null` — which also puts any',
  'standing Full-autonomy default back to asking.',
].join('\n');

/**
 * `dorkos config acknowledge-autonomy` — read what Full autonomy means, say yes,
 * and record it.
 *
 * ## Why the terminal needs its own door (DOR-1247)
 *
 * The consent record is what the config door asks for, and the cockpit gives it
 * through a dialog. A terminal had no way to produce one: `dorkos config set
 * runtimes.claudeCode.defaultTrustStop autonomy` was refused with a sentence and
 * no next step, which is a dead end for anyone who does not already know that
 * `ui.autonomyAcknowledgedAt` exists.
 *
 * So this is the terminal's version of that dialog, and it is deliberately the
 * same shape: it PRINTS what the person is agreeing to, then asks once, with no
 * as the default. Writing the record without reading it is still possible
 * (`config set ui.autonomyAcknowledgedAt <date>`), and that is a stated part of
 * the trust model rather than a hole this closes — a person with a shell can
 * sign their own form. See `config-write.ts` and
 * `contributing/configuration.md`.
 *
 * ## Why it refuses when nothing is attached
 *
 * A ritual needs somebody to perform it. With no TTY there is nobody to read the
 * text or answer, so a `--yes`-style flag here would be a consent form that
 * signs itself — the exact thing the door exists to prevent. A script that
 * genuinely means it can still write the record directly, which at least says
 * plainly what it is doing.
 *
 * The write goes through the guarded step like every other, so it lands in the
 * audit log: agreeing to this is itself a change worth being able to find later.
 *
 * @param store - Config storage instance
 * @param writer - How to reach the server's guarded write.
 * @param prompt - How the question reaches a person; injected for tests.
 */
export async function handleConfigAcknowledgeAutonomy(
  store: ConfigStore,
  writer: CliConfigWriter,
  prompt: ConsentPrompt = terminalConsentPrompt
): Promise<void> {
  const existing = store.getDot('ui.autonomyAcknowledgedAt');
  if (typeof existing === 'string' && existing.length > 0) {
    console.log(`You already confirmed this on ${existing}.`);
    console.log(
      'To take it back, run `dorkos config set ui.autonomyAcknowledgedAt null`, or use Settings.'
    );
    return;
  }

  if (!prompt.available()) {
    console.error('This needs to ask you a question, and nothing is attached to answer it.');
    console.error('Run it in a terminal, or confirm it in DorkOS under Settings.');
    process.exit(1);
  }

  console.log(`\n${AUTONOMY_CONSENT_TEXT}\n`);
  const agreed = await prompt.ask('Start every new session in Full autonomy?');
  if (!agreed) {
    console.log('Nothing changed.');
    return;
  }

  const acknowledgedAt = new Date().toISOString();
  const result = await writeOrExplain(
    writer,
    { ui: { autonomyAcknowledgedAt: acknowledgedAt } },
    ACKNOWLEDGE_AUTONOMY_COMMAND
  );
  if (!result.ok) {
    const reason = result.kind === 'invalid' ? result.error : result.refusal.message;
    console.error(`Could not record your answer: ${reason}`);
    process.exit(1);
  }

  console.log(`Recorded on ${acknowledgedAt}.`);
  console.log(
    'You can now set a Full-autonomy default, for example: `dorkos config set runtimes.defaultTrustStop autonomy`.'
  );
}

/**
 * How a consent question reaches a person.
 *
 * Two methods rather than one, because "is there anybody there?" and "what did
 * they say?" are different questions and the first has no honest boolean answer
 * from inside the second. Injected so the consent verb can be driven both ways
 * in a test — a vitest worker has no TTY, so a bare `process.stdin.isTTY` check
 * inside the handler made every path untestable except the refusal.
 */
export interface ConsentPrompt {
  /** Whether there is a person attached who could read the text and answer. */
  available(): boolean;
  /**
   * Ask the yes/no question.
   *
   * @param message - The question.
   */
  ask(message: string): Promise<boolean>;
}

/**
 * The real terminal: a TTY on stdin, and a yes/no that defaults to no.
 *
 * The prompt library is a lazy import so `dorkos config get` never pays to load
 * it.
 */
const terminalConsentPrompt: ConsentPrompt = {
  available: () => process.stdin.isTTY === true,
  async ask(message) {
    const { confirm } = await import('@inquirer/prompts');
    return confirm({ message, default: false });
  },
};
