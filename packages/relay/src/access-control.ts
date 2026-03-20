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
 * @module relay/access-control
 */
import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { matchesPattern } from './subject-matcher.js';
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type { AccessResult } from './types.js';

/** Filename for the persisted access rules. */
const RULES_FILENAME = 'access-rules.json';

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
 * Returns an empty array if the input is invalid JSON or not an array.
 *
 * @param raw - Raw JSON string from disk
 */
function parseRules(raw: string): RelayAccessRule[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as RelayAccessRule[];
  } catch {
    return [];
  }
}

/**
 * Pattern-based access control evaluator with file-backed persistence.
 *
 * Lifecycle:
 * 1. Construct with a data directory path
 * 2. Rules are loaded synchronously from `access-rules.json` on construction
 * 3. A chokidar watcher hot-reloads rules when the file changes on disk
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

  /**
   * Create a new AccessControl instance.
   *
   * Loads existing rules from `access-rules.json` in the given directory
   * and starts a chokidar file watcher for hot-reload.
   *
   * @param dataDir - Directory containing (or to contain) `access-rules.json`
   */
  constructor(dataDir: string) {
    this.rulesPath = path.join(dataDir, RULES_FILENAME);
    this.loadRules();
    this.startWatcher();
  }

  /**
   * Check whether communication from one subject to another is allowed.
   *
   * Evaluation algorithm:
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
   */
  addRule(rule: RelayAccessRule): void {
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
   */
  removeRule(from: string, to: string): void {
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
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load rules from disk synchronously.
   *
   * If the file doesn't exist or contains invalid JSON, the rules
   * array is reset to empty (default-allow for all).
   */
  private loadRules(): void {
    try {
      const raw = fs.readFileSync(this.rulesPath, 'utf-8');
      this.rules = parseRules(raw);
      this.rules.sort(byPriorityDesc);
    } catch {
      // File doesn't exist yet or is unreadable — start with no rules
      this.rules = [];
    }
  }

  /**
   * Atomically persist the current rules to disk.
   *
   * Writes to a temporary file first, then renames to the target path.
   * This prevents partial writes from corrupting the rules file.
   */
  private persistRules(): void {
    const tmpPath = this.rulesPath + '.tmp';
    const json = JSON.stringify(this.rules, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, this.rulesPath);
  }

  /**
   * Start a chokidar watcher on the rules file for hot-reload.
   *
   * When the file changes on disk (e.g., edited externally or by
   * another process), the rules are reloaded automatically.
   */
  private startWatcher(): void {
    this.watcher = chokidar.watch(this.rulesPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', () => {
      this.loadRules();
    });

    // Also reload if the file is created after construction
    this.watcher.on('add', () => {
      this.loadRules();
    });
  }
}
