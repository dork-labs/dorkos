/**
 * The durable record of who may install hooks, and who may not (DOR-522,
 * DOR-1849).
 *
 * ## What an entry is
 *
 * `<packageName>@<digest>`, where the digest covers the resolved project path
 * and every hook — command, event and matcher. The name is in front so a person
 * can read their own `~/.dork/config.json` and see which packages they have
 * decided about; the digest behind it is what makes the entry stop matching the
 * moment any of those change. Binding the command text alone would let a package
 * move an allowed command from `Stop` (once, at the end) to `PreToolUse` (before
 * every single tool call) without asking.
 *
 * It does NOT bind the CONTENT of a script the command invokes. A hook of the
 * form `node "${CLAUDE_PLUGIN_ROOT}/hooks/loop.mjs"` keeps its digest across an
 * update that rewrites `loop.mjs`. That is the same trade
 * `extension-load-policy.ts` states for an approved extension id, and it is the
 * honest limit of a gate on what lands in a settings file.
 *
 * ## Two lists, one digest, never both
 *
 * `harness.approvedHooks` holds the yeses and `harness.refusedHooks` the noes,
 * in the same form. Recording either side removes the matching entry from the
 * other, so a package is approved, refused, or undecided — never two of them.
 *
 * A refusal used to live in process memory only, on the reasoning that a durable
 * "no" would be a decision with nothing to undo it. That reasoning is spent:
 * `dorkos harness hooks --list` shows every stored decision and
 * `--revoke <package>` removes one, and a refusal expires on its own the moment
 * the package changes what it wants to run, because the digest stops matching.
 * A durable "no" is what lets a person's answer be obeyed by every later trigger
 * instead of being forgotten on the next restart.
 *
 * ## Where the record lives
 *
 * `~/.dork/config.json`, both leaves classified `operator-only` in
 * `core/operator/config-write-policy.ts` — the same home, and the same
 * reasoning, as `extensions.approvedToRun`. A record of a human decision must
 * not be writable by the thing the decision is about, and user config is where
 * this repo already keeps that: `config_patch` refuses `operator-only` paths,
 * `PATCH /api/config` refuses a caller carrying agent identity, and the drift
 * guards fail the build if the classification goes missing. The residual, stated:
 * with login off, a caller that simply omits its agent header is treated as the
 * operator (DOR-505). Turning on Require login closes it.
 *
 * ## Why there are two ways to READ the same file
 *
 * {@link storedHookDecisions} reads the running server's live store.
 * {@link readHookDecisionsFromDisk} parses `config.json` directly, and exists
 * for exactly one caller: `dorkos harness sync --check`, which is documented as
 * never writing anything (DOR-678). Opening a `conf` store is not a read —
 * measured, its constructor creates the directory and writes `config.json` when
 * either is absent — so a check-mode consult through the config manager would
 * plant a `~/.dork` in whatever directory the person happened to run it from.
 * The two must agree, which is why the read path parses the SAME Zod schema
 * rather than a hand-rolled shape of its own.
 *
 * @module services/harness/hook-consent
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectedHook } from '@dorkos/harness';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { configManager } from '../core/config-manager.js';
import { logConfigWrite } from '../core/operator/config-write.js';

/** One package's request to install shell commands into a project's harnesses. */
export interface HookProjectionRequest {
  /** The project whose harness files would be written. */
  projectPath: string;
  /** The installed package that declared the hooks. */
  packageName: string;
  /**
   * Exactly what would land: each command, the event that fires it, and the
   * matcher that narrows it. Sorted by `projectedHooks`, so a package that only
   * reorders its `hooks.json` is not asked about again.
   */
  hooks: ProjectedHook[];
}

/** The two stored lists, read together so a caller cannot consult one and forget the other. */
export interface HookDecisions {
  /** `<packageName>@<digest>` entries a person allowed. */
  approved: readonly string[];
  /** `<packageName>@<digest>` entries a person turned down. */
  refused: readonly string[];
  /**
   * Why the lists are empty because the FILE could not be read, when that is
   * what happened.
   *
   * A missing `config.json` is a fresh install and leaves this absent: nothing
   * has been decided, and "nothing decided" is the truth. A truncated or
   * schema-invalid one is a different thing entirely, and collapsing the two
   * made every surface say the opposite of what was true — "you have not
   * allowed this package yet" about a package somebody had allowed, and "no
   * hook decisions stored yet" over a file full of them. Worse, the way out it
   * then suggested (`--fix --allow-hooks`) opens the config store, whose
   * corrupt-recovery backs the file up and resets EVERY setting to defaults.
   *
   * Carrying the reason lets each surface say the true thing and stop.
   */
  unreadable?: string;
}

/** Nothing decided — the shape a fresh install resolves to. */
const NO_DECISIONS: HookDecisions = { approved: [], refused: [] };

/**
 * The canonical form of a request, so two ways of naming the same thing hash the
 * same.
 *
 * `path.resolve` is the whole of it, and it is not cosmetic: `/x/proj` and
 * `/x/proj/` are one directory, and the app is not the only caller — the CLI and
 * the API pass whatever a person or a script typed. Without this, one project
 * could hold two decisions and a person would be asked twice for the same thing.
 */
function canonicalProjectPath(request: HookProjectionRequest): string {
  return resolve(request.projectPath);
}

/**
 * The stored form of one hook decision: `<packageName>@<digest>`.
 *
 * The same function writes an approval and a refusal, which is what makes the
 * two lists comparable and makes "an entry is never in both" checkable.
 *
 * @param request - The package, project, and hooks to identify.
 * @returns The entry as it is stored in `harness.approvedHooks` or
 *   `harness.refusedHooks`.
 */
export function hookApprovalEntry(request: HookProjectionRequest): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        canonicalProjectPath(request),
        request.hooks.map((hook) => [hook.event, hook.matcher ?? null, hook.command]),
      ]),
      'utf8'
    )
    .digest('hex');
  return `${request.packageName}@${digest}`;
}

/**
 * The package name half of a stored entry.
 *
 * Split on the LAST `@`, because a scoped package name carries one of its own
 * (`@acme/tools@<digest>`) and the digest never does.
 *
 * @param entry - A stored `<packageName>@<digest>` entry.
 * @returns The package name, or the whole entry when it carries no `@`.
 */
export function hookEntryPackageName(entry: string): string {
  const at = entry.lastIndexOf('@');
  return at <= 0 ? entry : entry.slice(0, at);
}

/**
 * Both stored lists, as the running server sees them.
 *
 * @returns The approved and refused entries.
 */
export function storedHookDecisions(): HookDecisions {
  const harness = configManager.get('harness');
  return { approved: harness.approvedHooks, refused: harness.refusedHooks };
}

/**
 * Both stored lists, read straight off `config.json` without opening the store.
 *
 * For the one caller that must not write: see "Why there are two ways to READ
 * the same file" above.
 *
 * Three outcomes, and telling the last two apart is the whole point. A file that
 * is not there is a fresh install: nothing decided, and every package's hooks
 * are simply unasked. A file that IS there and cannot be read — truncated,
 * hand-edited into invalid JSON, a `harness` block the schema rejects — is
 * reported as {@link HookDecisions.unreadable}, so the caller says so instead of
 * announcing that nobody has decided anything. Both fail CLOSED either way:
 * nothing is installed on the strength of a file DorkOS could not parse.
 *
 * A file that is missing its `harness` block entirely is NOT unreadable: the
 * schema supplies the section's defaults, which is the same answer the running
 * server would give.
 *
 * @param dorkHome - The resolved DorkOS data directory holding `config.json`.
 * @returns The approved and refused entries, or the reason there are none.
 */
export function readHookDecisionsFromDisk(dorkHome: string): HookDecisions {
  const configPath = join(dorkHome, 'config.json');
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    // Absent is the ordinary case and the honest one. Anything else about the
    // file itself — a permission the operating system changed, a directory
    // where the file should be — is a reason a person needs to hear.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NO_DECISIONS;
    return { ...NO_DECISIONS, unreadable: describeReadFailure(err) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ...NO_DECISIONS, unreadable: describeReadFailure(err) };
  }

  const stored = (raw as { harness?: unknown } | null)?.harness;
  const parsed = UserConfigSchema.shape.harness.safeParse(stored);
  if (!parsed.success) {
    return {
      ...NO_DECISIONS,
      unreadable: `the "harness" settings are not in a shape DorkOS understands (${parsed.error.issues[0]?.message ?? 'invalid'})`,
    };
  }
  return { approved: parsed.data.approvedHooks, refused: parsed.data.refusedHooks };
}

/** One short clause naming what went wrong, for a message a person reads. */
function describeReadFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a person has already allowed exactly this package to install exactly
 * these hooks into exactly this project.
 *
 * @param request - The projection about to happen.
 * @param decisions - The stored lists; defaults to the running server's.
 * @returns True when a stored yes covers it.
 */
export function isHookProjectionApproved(
  request: HookProjectionRequest,
  decisions: HookDecisions = storedHookDecisions()
): boolean {
  return decisions.approved.includes(hookApprovalEntry(request));
}

/**
 * Whether a person has already turned exactly these hooks down for this project.
 *
 * @param request - The projection about to happen.
 * @param decisions - The stored lists; defaults to the running server's.
 * @returns True when a stored no covers it.
 */
export function isHookProjectionRefused(
  request: HookProjectionRequest,
  decisions: HookDecisions = storedHookDecisions()
): boolean {
  return decisions.refused.includes(hookApprovalEntry(request));
}

/**
 * Write both lists back, log what moved, and say nothing when nothing changed.
 *
 * One writer for both sides so the "never in both" invariant lives in a single
 * place rather than in each caller.
 */
function writeDecisions(reason: string, approved: string[], refused: string[]): void {
  const harness = configManager.get('harness');
  const sameApproved =
    approved.length === harness.approvedHooks.length &&
    approved.every((entry, i) => entry === harness.approvedHooks[i]);
  const sameRefused =
    refused.length === harness.refusedHooks.length &&
    refused.every((entry, i) => entry === harness.refusedHooks[i]);
  if (sameApproved && sameRefused) return;
  configManager.set('harness', { ...harness, approvedHooks: approved, refusedHooks: refused });
  logConfigWrite(reason, 'harness', harness, configManager.get('harness'));
}

/**
 * Record a person's yes, so the same package projecting the same hooks into the
 * same project is never asked about again.
 *
 * Idempotent, and it clears any matching refusal: a package cannot be approved
 * and refused at once.
 *
 * @param request - The projection that was allowed.
 */
export function recordHookApproval(request: HookProjectionRequest): void {
  const entry = hookApprovalEntry(request);
  const { approved, refused } = storedHookDecisions();
  writeDecisions(
    'approving a package hook',
    approved.includes(entry) ? [...approved] : [...approved, entry],
    refused.filter((stored) => stored !== entry)
  );
}

/**
 * Record a person's no, so every later trigger obeys it instead of asking again.
 *
 * Idempotent, and it clears any matching approval — the same package cannot be
 * on both lists. The refusal ends on its own when the package changes what it
 * wants to run (a different digest matches neither list), and a person can end
 * it early with `dorkos harness hooks --revoke <package>`.
 *
 * @param request - The projection that was turned down.
 */
export function recordHookRefusal(request: HookProjectionRequest): void {
  const entry = hookApprovalEntry(request);
  const { approved, refused } = storedHookDecisions();
  writeDecisions(
    'turning down a package hook',
    approved.filter((stored) => stored !== entry),
    refused.includes(entry) ? [...refused] : [...refused, entry]
  );
}

/** One stored decision, removed by {@link revokeHookDecisions}. */
export interface RevokedHookDecision {
  /** The entry as it was stored. */
  entry: string;
  /** Which list it came off. */
  decision: 'approved' | 'refused';
}

/**
 * Forget every stored decision recorded for one package.
 *
 * Scoped by package NAME rather than by project, and that is the honest scope
 * rather than a shortcut: the digest is one-way, so a stored entry cannot say
 * which project it was recorded in. Only the entry matching what the package
 * declares in the project you are standing in can be identified, and every other
 * entry for that name is already inert — its digest matches nothing, so the
 * package is treated as undecided wherever it now differs. Removing a decision
 * only ever means "ask me again", so the wider scope cannot arm anything; the
 * caller prints each entry it removed and says which one matched here.
 *
 * @param packageName - The package whose decisions to forget.
 * @returns What was removed, in the order the lists held it.
 */
export function revokeHookDecisions(packageName: string): RevokedHookDecision[] {
  const { approved, refused } = storedHookDecisions();
  const mine = (entry: string): boolean => hookEntryPackageName(entry) === packageName;
  const removed: RevokedHookDecision[] = [
    ...approved.filter(mine).map((entry) => ({ entry, decision: 'approved' as const })),
    ...refused.filter(mine).map((entry) => ({ entry, decision: 'refused' as const })),
  ];
  if (removed.length === 0) return [];
  writeDecisions(
    'revoking a package hook decision',
    approved.filter((entry) => !mine(entry)),
    refused.filter((entry) => !mine(entry))
  );
  return removed;
}
