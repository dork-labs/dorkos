/**
 * Pattern-based access control for the Relay message bus.
 *
 * Evaluates allow/deny rules to determine whether a message from one
 * subject can be delivered to another. Rules are sorted by priority
 * (highest first) and the first matching rule wins. If no rule matches,
 * the default policy is **allow** (matching the D-Bus session bus model).
 *
 * Rules are persisted in `access-rules.json` within the Relay data
 * directory and hot-reloaded via chokidar when the file changes on disk.
 *
 * ## No rules and unreadable rules are different answers
 *
 * A **missing** file means nobody has written a rule yet, so the D-Bus-style
 * default-allow applies and everything is delivered. A file that **exists but
 * cannot be read as rules** means somebody wrote rules and we cannot tell what
 * they say — and the rule we cannot read is exactly as likely to be the `deny`
 * protecting a private namespace as anything else. Treating that as "no rules"
 * silently converts a locked-down machine into an open one at the moment its
 * config breaks, which is the worst possible time. So an unreadable file puts
 * the evaluator into a **quarantined** state that denies every check until the
 * file is fixed or removed; the chokidar watcher lifts the quarantine on the
 * next good load, with no restart.
 *
 * @module relay/access-control
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchesPattern } from './subject-matcher.js';
import { RelayAccessRuleSchema } from '@dorkos/shared/relay-schemas';
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type { AccessResult, RelayLogger } from './types.js';

/** The logger surface {@link AccessControl} uses to report a quarantine. */
export type AccessControlLogger = Partial<RelayLogger>;

/** Filename for the persisted access rules. */
const RULES_FILENAME = 'access-rules.json';

/**
 * How long the rules file must sit unchanged before the watcher reads it.
 *
 * Exported because anything that writes the file and then waits to observe the
 * reload has to leave it alone for longer than this, or chokidar's
 * `awaitWriteFinish` restarts its stability timer and never emits at all.
 *
 * @internal Exported for testing only.
 */
export const RULES_WRITE_STABILITY_MS = 100;

/**
 * Sort comparator for access rules — highest priority first.
 *
 * @param a - First rule
 * @param b - Second rule
 */
function byPriorityDesc(a: RelayAccessRule, b: RelayAccessRule): number {
  return b.priority - a.priority;
}

/**
 * Parse a JSON string into an array of access rules.
 *
 * Every entry is validated against {@link RelayAccessRuleSchema}: a rule that
 * does not hold is not silently dropped, because a dropped rule is a rule that
 * stops protecting something. One bad entry fails the whole file, which the
 * caller turns into a quarantine rather than into "no rules".
 *
 * @param raw - Raw JSON string from disk.
 * @returns The parsed rules, or `null` when the text is not a valid rule list.
 */
function parseRules(raw: string): RelayAccessRule[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const result = RelayAccessRuleSchema.array().safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Pattern-based access control evaluator with file-backed persistence.
 *
 * Lifecycle:
 * 1. Construct with a data directory path
 * 2. Rules are loaded synchronously from `access-rules.json` on construction
 * 3. A chokidar watcher hot-reloads rules when the file changes on disk;
 *    {@link whenWatcherReady} says when that watcher has attached
 * 4. Call {@link close} to stop watching and release resources
 *
 * @example
 * ```typescript
 * const acl = new AccessControl('/home/user/.dork/relay');
 * const result = acl.checkAccess('relay.agent.projectA.backend', 'relay.agent.projectB.frontend');
 * if (!result.allowed) {
 *   console.log('Blocked by rule:', result.matchedRule);
 * }
 * acl.close();
 * ```
 */
export class AccessControl {
  private rules: RelayAccessRule[] = [];
  private watcher: FSWatcher | null = null;
  private readonly rulesPath: string;
  /** Resolves once the hot-reload watcher has settled — see {@link whenWatcherReady}. */
  private readonly watcherReady: Promise<void>;
  /** Resolver for {@link watcherReady}; nulled the moment it settles, so it settles once. */
  private settleWatcherReady: (() => void) | null = null;
  /**
   * Why the rules file could not be read, when it exists but is unreadable.
   *
   * Non-null puts the evaluator in the quarantined state described in the
   * module doc: {@link checkAccess} denies everything. Cleared on the next
   * successful load, so fixing or deleting the file recovers without a restart.
   */
  private quarantineReason: string | null = null;
  private readonly logger?: AccessControlLogger;

  /**
   * Create a new AccessControl instance.
   *
   * Loads existing rules from `access-rules.json` in the given directory
   * and starts a chokidar file watcher for hot-reload.
   *
   * @param dataDir - Directory containing (or to contain) `access-rules.json`
   * @param logger - Optional logger; the quarantine is otherwise invisible.
   */
  constructor(dataDir: string, logger?: AccessControlLogger) {
    this.rulesPath = path.join(dataDir, RULES_FILENAME);
    this.logger = logger;
    this.loadRules();
    this.watcherReady = this.startWatcher();
  }

  /**
   * Wait until the hot-reload watcher has finished starting up.
   *
   * Rules are loaded synchronously in the constructor, so an evaluator answers
   * correctly the instant it exists; this concerns hot-reload only. Callers
   * that are about to change `access-rules.json` and expect the change to be
   * picked up — tests, above all — gate on this instead of sleeping.
   *
   * It resolves and never rejects, in three cases: chokidar reported `ready`;
   * the watcher failed before it ever went ready (an EMFILE-style failure emits
   * `error` and no `ready` at all, so without this the promise would hang
   * forever); or {@link close} was called first, after which `ready` is never
   * coming.
   *
   * Note the limit of what `ready` promises. chokidar reports it as soon as it
   * has attached its listeners, which on macOS is a few milliseconds before
   * libuv's FSEvents stream actually starts delivering; a write landing inside
   * that window is dropped rather than delivered late. So this is a gate on
   * "the watcher is attached", not a guarantee that the very next write is
   * seen — a caller that must observe its own write should repeat it until it
   * does.
   *
   * @returns A promise that resolves once the watcher has settled.
   */
  whenWatcherReady(): Promise<void> {
    return this.watcherReady;
  }

  /**
   * Whether the evaluator is quarantined because `access-rules.json` exists but
   * cannot be read as a rule list. While quarantined every check is denied.
   */
  isQuarantined(): boolean {
    return this.quarantineReason !== null;
  }

  /**
   * Check whether communication from one subject to another is allowed.
   *
   * Evaluation algorithm:
   * 0. If the rules file is unreadable, deny — see the module doc
   * 1. Rules are sorted by priority (highest first)
   * 2. For each rule, check if `matchesPattern(from, rule.from)` AND `matchesPattern(to, rule.to)`
   * 3. First match wins — return the corresponding allow/deny result
   * 4. No match — default-allow
   *
   * @param from - The sender subject
   * @param to - The recipient subject
   * @returns An {@link AccessResult} indicating whether delivery is allowed
   */
  checkAccess(from: string, to: string): AccessResult {
    if (this.quarantineReason !== null) {
      return {
        allowed: false,
        reason:
          `the relay access rules at ${this.rulesPath} cannot be read ` +
          `(${this.quarantineReason}), so nothing is being delivered until they are ` +
          `fixed or the file is removed`,
      };
    }

    for (const rule of this.rules) {
      if (matchesPattern(from, rule.from) && matchesPattern(to, rule.to)) {
        return {
          allowed: rule.action === 'allow',
          matchedRule: rule,
        };
      }
    }

    // Default-allow when no rules match
    return { allowed: true };
  }

  /**
   * Add an access rule and persist the updated rule set.
   *
   * The new rule is inserted in priority order. If a rule with the
   * same `from`, `to`, and `priority` already exists, it is replaced.
   *
   * @param rule - The access rule to add
   * @throws While quarantined — see {@link assertWritable}.
   */
  addRule(rule: RelayAccessRule): void {
    this.assertWritable('add a rule');
    // Remove any exact duplicate (same from + to + priority)
    this.rules = this.rules.filter(
      (r) => !(r.from === rule.from && r.to === rule.to && r.priority === rule.priority)
    );
    this.rules.push(rule);
    this.rules.sort(byPriorityDesc);
    this.persistRules();
  }

  /**
   * Remove the first rule matching the given `from` and `to` patterns.
   *
   * @param from - The `from` pattern to match
   * @param to - The `to` pattern to match
   * @throws While quarantined — see {@link assertWritable}.
   */
  removeRule(from: string, to: string): void {
    this.assertWritable('remove a rule');
    const index = this.rules.findIndex((r) => r.from === from && r.to === to);
    if (index !== -1) {
      this.rules.splice(index, 1);
      this.persistRules();
    }
  }

  /**
   * Return a shallow copy of the current rules list.
   *
   * @returns Array of access rules sorted by priority (highest first)
   */
  listRules(): RelayAccessRule[] {
    return [...this.rules];
  }

  /**
   * Stop the chokidar file watcher and release resources.
   *
   * Safe to call multiple times.
   */
  close(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    // A closed watcher never emits 'ready', so anyone still awaiting startup
    // would wait for an event that is not coming.
    this.finishWatcherStartup();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Refuse to write the rules file while it cannot be read.
   *
   * A quarantined evaluator holds NO rules — it deliberately did not guess at
   * what the unreadable file said. Persisting from that state would write an
   * empty list plus whatever was just added, destroying the very file the
   * quarantine exists to preserve and turning a typo into permanent loss of
   * every rule. It would also silently lift the quarantine, because the file
   * would then parse.
   *
   * So the write is refused and the caller is told why. Repair or delete the
   * file first; the watcher lifts the quarantine and rules become editable
   * again with no restart.
   *
   * @param action - What the caller was trying to do, for the message.
   * @throws When the rules file is unreadable.
   */
  private assertWritable(action: string): void {
    if (this.quarantineReason === null) return;
    throw new Error(
      `Cannot ${action}: the relay access rules at ${this.rulesPath} cannot be read ` +
        `(${this.quarantineReason}). Saving now would overwrite them with an empty list. ` +
        `Fix or delete that file first — it is left exactly as it is until you do.`
    );
  }

  /**
   * Load rules from disk synchronously.
   *
   * Three outcomes, and the difference between the last two is the whole point
   * (see the module doc):
   *
   * - **File read and parsed** — those are the rules; any quarantine is lifted.
   * - **File absent (`ENOENT`)** — nobody has written a rule; default-allow.
   * - **File present but unreadable or unparseable** — quarantine: deny
   *   everything until it is fixed or removed.
   */
  private loadRules(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.rulesPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.rules = [];
        this.clearQuarantine();
        return;
      }
      // The file is there and we cannot read it (permissions, I/O). We do not
      // know what it says, so we do not get to assume it says nothing.
      this.enterQuarantine(err instanceof Error ? err.message : String(err));
      return;
    }

    const parsed = parseRules(raw);
    if (parsed === null) {
      this.enterQuarantine('the file is not a valid list of access rules');
      return;
    }

    this.rules = parsed;
    this.rules.sort(byPriorityDesc);
    this.clearQuarantine();
  }

  /** Enter the deny-everything state and say so once, loudly. */
  private enterQuarantine(reason: string): void {
    this.rules = [];
    if (this.quarantineReason !== reason) {
      this.logger?.error?.(
        `[Relay] Refusing to deliver messages: ${this.rulesPath} exists but ${reason}. ` +
          `Access control cannot be evaluated, so every message is denied until the file ` +
          `is repaired or deleted.`
      );
    }
    this.quarantineReason = reason;
  }

  /** Leave the deny-everything state after a good load. */
  private clearQuarantine(): void {
    if (this.quarantineReason !== null) {
      this.quarantineReason = null;
      this.logger?.warn?.(
        `[Relay] ${this.rulesPath} is readable again — access control is back in effect.`
      );
    }
  }

  /**
   * Atomically persist the current rules to disk.
   *
   * Writes to a temporary file first, then renames to the target path, so a
   * partial write can never corrupt the rules file.
   *
   * No path lock is needed here, unlike the async stores that share
   * `@dorkos/shared/atomic-write`: these calls are synchronous, so the event
   * loop cannot run another writer between the write and the rename. The temp
   * name is still unique per call so that a writer in a *different* process
   * cannot clobber this one's temp file.
   */
  private persistRules(): void {
    const tmpPath = `${this.rulesPath}.${process.pid}.${randomUUID()}.tmp`;
    const json = JSON.stringify(this.rules, null, 2);
    try {
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.rulesPath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  }

  /**
   * Settle {@link watcherReady} exactly once, from whichever end got there
   * first — `ready`, a pre-ready failure, or {@link close}.
   */
  private finishWatcherStartup(): void {
    const settle = this.settleWatcherReady;
    this.settleWatcherReady = null;
    settle?.();
  }

  /**
   * Start a chokidar watcher on the rules file for hot-reload.
   *
   * When the file changes on disk (e.g., edited externally or by
   * another process), the rules are reloaded automatically.
   *
   * @returns The promise behind {@link whenWatcherReady}.
   */
  private startWatcher(): Promise<void> {
    const ready = new Promise<void>((resolve) => {
      this.settleWatcherReady = resolve;
    });

    this.watcher = chokidar.watch(this.rulesPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: RULES_WRITE_STABILITY_MS,
        pollInterval: 50,
      },
    });

    this.watcher.on('ready', () => {
      this.finishWatcherStartup();
    });

    this.watcher.on('change', () => {
      this.loadRules();
    });

    // Also reload if the file is created after construction
    this.watcher.on('add', () => {
      this.loadRules();
    });

    // Deleting a broken rules file is a legitimate repair — it returns the
    // machine to "nobody has written a rule". Without this the quarantine would
    // outlive the file that caused it, until the next restart.
    this.watcher.on('unlink', () => {
      this.loadRules();
    });

    // A watcher that fails before it goes ready (e.g. EMFILE) never emits
    // 'ready' at all, so the startup promise is settled from the error handler
    // too — otherwise every caller awaiting it would hang forever. Settling
    // rather than rejecting matches what a failed watcher actually costs:
    // rules already loaded keep being enforced, only hot-reload is gone.
    //
    // Without this handler a watcher failure (e.g. EMFILE) has nowhere to go
    // but the process-wide unhandled-error path. Rules already loaded keep
    // being enforced and a quarantine already in force stays in force; what
    // stops is hot-reload, so a repair to the file goes unnoticed until the
    // process restarts. Latched per distinct error code rather than a single
    // boolean: a benign EACCES must never suppress the EMFILE storm that
    // follows it. The Set lives in this per-instance closure, so one relay's
    // latch cannot silence another's.
    const seenCodes = new Set<string>();
    this.watcher.on('error', (err) => {
      this.finishWatcherStartup();
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      // Logged as an explicit object, never the bare Error: the server's NDJSON
      // reporter spreads what it is given, and `message`/`stack` are
      // non-enumerable on an Error, so they would vanish (DOR-832).
      this.logger?.warn?.(
        `[watcher-error] AccessControl: ${this.rulesPath} — further ${code} errors from this watcher are suppressed`,
        {
          rulesPath: this.rulesPath,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
        }
      );
    });

    return ready;
  }
}
