/**
 * Tests for {@link AccessControl}.
 *
 * Rule evaluation is synchronous and file-backed, so most of this file is
 * ordinary. The watcher is not: by default every test here runs against an
 * INJECTED watcher it drives itself (see `./fake-watcher.ts`), because polling a
 * hand-rolled deadline for a real fs event measures the machine's latency rather
 * than this class's behaviour, and went red under multi-agent load (DOR-1777).
 * Exactly one test — the last in the `hot-reload` block — puts the real chokidar
 * back, and it is the only wall-clock bound in the file.
 *
 * @module __tests__/access-control
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccessControl } from '../access-control.js';
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type { AccessControlLogger } from '../access-control.js';
import { interceptChokidar, type ChokidarInterceptor } from './fake-watcher.js';

/** A spy logger satisfying the {@link AccessControlLogger} surface. */
function createSpyLogger(): AccessControlLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test isolation. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acl-test-'));
}

/** Write rules directly to the access-rules.json file. */
function writeRulesFile(dir: string, rules: RelayAccessRule[]): void {
  fs.writeFileSync(path.join(dir, 'access-rules.json'), JSON.stringify(rules, null, 2), 'utf-8');
}

/** Read rules directly from the access-rules.json file. */
function readRulesFile(dir: string): RelayAccessRule[] {
  const raw = fs.readFileSync(path.join(dir, 'access-rules.json'), 'utf-8');
  return JSON.parse(raw) as RelayAccessRule[];
}

function makeRule(
  from: string,
  to: string,
  action: 'allow' | 'deny',
  priority: number
): RelayAccessRule {
  return { from, to, action, priority };
}

/** Wait for a specified number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long the one real-filesystem test gives the platform before giving up.
 *
 * Deliberately generous and deliberately alone: it is the only wall-clock bound
 * left in this file, and it is paid in full only when the watcher is broken.
 * Everywhere else the watcher is injected and there is nothing to wait for.
 */
const REAL_RELOAD_TIMEOUT_MS = 15_000;
/** How often that one test re-checks while waiting. */
const RELOAD_POLL_MS = 50;

/**
 * Poll until `predicate` holds, or fail loudly.
 *
 * The change under test is made exactly once, before this is called; only its
 * observation is outstanding. That single write is enough because
 * `whenWatcherReady()` does not resolve until the watcher is actually
 * delivering — a helper that re-applied its write to paper over a missed event
 * would report a watcher that drops events as healthy, which is the bug the
 * real-filesystem test exists to catch.
 *
 * @param predicate - The condition being waited on.
 * @param what - Named in the failure message, so a timeout says what was lost.
 * @param timeoutMs - Budget for this wait.
 */
async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = REAL_RELOAD_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(RELOAD_POLL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccessControl', () => {
  let tmpDir: string;
  let acl: AccessControl;
  let chokidarSpy: ChokidarInterceptor;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Injected by default. Constructing an evaluator starts a watcher whether
    // the test cares about hot-reload or not, and thirty real watchers per run
    // is thirty file descriptors and thirty chances to be slow for no coverage
    // at all. The one test that wants the real thing calls `restore()`.
    chokidarSpy = interceptChokidar();
  });

  afterEach(() => {
    acl?.close();
    vi.restoreAllMocks();
    // Clean up tmp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Default-allow
  // -------------------------------------------------------------------------

  describe('default-allow policy', () => {
    it('allows all communication when no rules exist', () => {
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess(
        'relay.agent.projectA.backend',
        'relay.agent.projectB.frontend'
      );

      expect(result.allowed).toBe(true);
      expect(result.matchedRule).toBeUndefined();
    });

    it('allows communication when no rules match', () => {
      writeRulesFile(tmpDir, [
        makeRule('relay.agent.projectX.*', 'relay.agent.projectY.*', 'deny', 10),
      ]);
      acl = new AccessControl(tmpDir);

      // These subjects don't match the deny rule
      const result = acl.checkAccess(
        'relay.agent.projectA.backend',
        'relay.agent.projectB.frontend'
      );

      expect(result.allowed).toBe(true);
      expect(result.matchedRule).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Allow rules
  // -------------------------------------------------------------------------

  describe('allow rules', () => {
    it('permits communication when an allow rule matches', () => {
      const rule = makeRule(
        'relay.agent.projectA.backend',
        'relay.agent.projectA.frontend',
        'allow',
        10
      );
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess(
        'relay.agent.projectA.backend',
        'relay.agent.projectA.frontend'
      );

      expect(result.allowed).toBe(true);
      expect(result.matchedRule).toEqual(rule);
    });

    it('returns the matched allow rule in the result', () => {
      const rule = makeRule('relay.agent.>', 'relay.agent.>', 'allow', 5);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess(
        'relay.agent.projectA.backend',
        'relay.agent.projectB.frontend'
      );

      expect(result.matchedRule).toEqual(rule);
    });
  });

  // -------------------------------------------------------------------------
  // Deny rules
  // -------------------------------------------------------------------------

  describe('deny rules', () => {
    it('blocks communication when a deny rule matches', () => {
      const rule = makeRule('relay.agent.projectA.*', 'relay.agent.projectB.*', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess(
        'relay.agent.projectA.backend',
        'relay.agent.projectB.frontend'
      );

      expect(result.allowed).toBe(false);
      expect(result.matchedRule).toEqual(rule);
    });

    it('returns the matched deny rule in the result', () => {
      const rule = makeRule('relay.agent.evil', 'relay.agent.innocent', 'deny', 100);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess('relay.agent.evil', 'relay.agent.innocent');

      expect(result.allowed).toBe(false);
      expect(result.matchedRule).toEqual(rule);
    });
  });

  // -------------------------------------------------------------------------
  // Priority ordering
  // -------------------------------------------------------------------------

  describe('priority ordering', () => {
    it('evaluates higher-priority rules first (first match wins)', () => {
      const denyRule = makeRule('relay.agent.>', 'relay.agent.>', 'deny', 5);
      const allowRule = makeRule('relay.agent.projectA.*', 'relay.agent.projectB.*', 'allow', 10);
      // Write in wrong order to verify sorting
      writeRulesFile(tmpDir, [denyRule, allowRule]);
      acl = new AccessControl(tmpDir);

      // The allow rule (priority 10) should win over deny (priority 5)
      const result = acl.checkAccess(
        'relay.agent.projectA.backend',
        'relay.agent.projectB.frontend'
      );

      expect(result.allowed).toBe(true);
      expect(result.matchedRule).toEqual(allowRule);
    });

    it('lower-priority deny overridden by higher-priority allow', () => {
      const rules: RelayAccessRule[] = [
        makeRule('relay.agent.>', 'relay.agent.>', 'deny', 1),
        makeRule('relay.agent.trusted.*', 'relay.agent.>', 'allow', 100),
      ];
      writeRulesFile(tmpDir, rules);
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess('relay.agent.trusted.bot', 'relay.agent.projectX.worker');

      expect(result.allowed).toBe(true);
      expect(result.matchedRule?.priority).toBe(100);
    });

    it('higher-priority deny blocks despite lower-priority allow', () => {
      const rules: RelayAccessRule[] = [
        makeRule('relay.agent.>', 'relay.agent.>', 'allow', 1),
        makeRule('relay.agent.blocked.*', 'relay.agent.>', 'deny', 100),
      ];
      writeRulesFile(tmpDir, rules);
      acl = new AccessControl(tmpDir);

      const result = acl.checkAccess('relay.agent.blocked.bot', 'relay.agent.projectX.worker');

      expect(result.allowed).toBe(false);
      expect(result.matchedRule?.priority).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // Wildcard patterns
  // -------------------------------------------------------------------------

  describe('wildcard patterns', () => {
    it('single wildcard (*) matches one token in from', () => {
      const rule = makeRule('relay.agent.*.backend', 'relay.agent.projectB.frontend', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      expect(
        acl.checkAccess('relay.agent.projectA.backend', 'relay.agent.projectB.frontend').allowed
      ).toBe(false);
      expect(
        acl.checkAccess('relay.agent.projectZ.backend', 'relay.agent.projectB.frontend').allowed
      ).toBe(false);
    });

    it('single wildcard (*) does not match multiple tokens', () => {
      const rule = makeRule('relay.agent.*', 'relay.agent.projectB.frontend', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      // relay.agent.projectA.backend has two tokens after relay.agent, * only matches one
      expect(
        acl.checkAccess('relay.agent.projectA.backend', 'relay.agent.projectB.frontend').allowed
      ).toBe(true);
    });

    it('multi-wildcard (>) matches one or more tokens in to', () => {
      const rule = makeRule('relay.agent.sender', 'relay.agent.>', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      expect(acl.checkAccess('relay.agent.sender', 'relay.agent.any').allowed).toBe(false);
      expect(acl.checkAccess('relay.agent.sender', 'relay.agent.deep.nested.path').allowed).toBe(
        false
      );
    });

    it('wildcards work in both from and to simultaneously', () => {
      const rule = makeRule('relay.agent.*.backend', 'relay.agent.>', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      expect(
        acl.checkAccess('relay.agent.projectA.backend', 'relay.agent.projectB.frontend').allowed
      ).toBe(false);
      expect(
        acl.checkAccess('relay.agent.projectA.backend', 'relay.agent.any.nested.path').allowed
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // addRule / removeRule
  // -------------------------------------------------------------------------

  describe('addRule', () => {
    it('adds a rule that affects subsequent checkAccess calls', () => {
      acl = new AccessControl(tmpDir);

      // Initially allowed (no rules)
      expect(acl.checkAccess('relay.sender', 'relay.receiver').allowed).toBe(true);

      acl.addRule(makeRule('relay.sender', 'relay.receiver', 'deny', 10));

      // Now blocked
      expect(acl.checkAccess('relay.sender', 'relay.receiver').allowed).toBe(false);
    });

    it('persists added rules to access-rules.json', () => {
      acl = new AccessControl(tmpDir);

      const rule = makeRule('relay.agent.a', 'relay.agent.b', 'deny', 5);
      acl.addRule(rule);

      const persisted = readRulesFile(tmpDir);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toEqual(rule);
    });

    it('maintains priority ordering after adding multiple rules', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 5));
      acl.addRule(makeRule('relay.c', 'relay.d', 'allow', 20));
      acl.addRule(makeRule('relay.e', 'relay.f', 'deny', 10));

      const rules = acl.listRules();
      expect(rules[0].priority).toBe(20);
      expect(rules[1].priority).toBe(10);
      expect(rules[2].priority).toBe(5);
    });

    it('replaces duplicate rules with same from/to/priority', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10));
      acl.addRule(makeRule('relay.a', 'relay.b', 'allow', 10));

      const rules = acl.listRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('allow');
    });
  });

  describe('removeRule', () => {
    it('removes a rule matching from and to', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.sender', 'relay.receiver', 'deny', 10));
      expect(acl.checkAccess('relay.sender', 'relay.receiver').allowed).toBe(false);

      acl.removeRule('relay.sender', 'relay.receiver');
      expect(acl.checkAccess('relay.sender', 'relay.receiver').allowed).toBe(true);
    });

    it('persists removal to access-rules.json', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 5));
      acl.addRule(makeRule('relay.c', 'relay.d', 'allow', 10));
      acl.removeRule('relay.a', 'relay.b');

      const persisted = readRulesFile(tmpDir);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].from).toBe('relay.c');
    });

    it('does nothing if no rule matches', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 5));
      acl.removeRule('relay.x', 'relay.y');

      expect(acl.listRules()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // listRules
  // -------------------------------------------------------------------------

  describe('listRules', () => {
    it('returns an empty array when no rules exist', () => {
      acl = new AccessControl(tmpDir);

      expect(acl.listRules()).toEqual([]);
    });

    it('returns a copy (modifying returned array does not affect internal state)', () => {
      acl = new AccessControl(tmpDir);
      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 5));

      const rules = acl.listRules();
      rules.length = 0; // Mutate the returned array

      expect(acl.listRules()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // File loading
  // -------------------------------------------------------------------------

  describe('file loading', () => {
    it('loads rules from an existing access-rules.json on construction', () => {
      const rule = makeRule('relay.sender', 'relay.receiver', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);

      acl = new AccessControl(tmpDir);

      expect(acl.checkAccess('relay.sender', 'relay.receiver').allowed).toBe(false);
    });

    it('handles missing access-rules.json gracefully (default-allow)', () => {
      acl = new AccessControl(tmpDir);

      expect(acl.checkAccess('relay.any', 'relay.other').allowed).toBe(true);
      expect(acl.listRules()).toEqual([]);
    });

    // Corrupt and non-array files used to load as "no rules", i.e. as
    // default-allow. They now quarantine — see the fail-closed block below.
  });

  // -------------------------------------------------------------------------
  // Hot-reload via chokidar
  // -------------------------------------------------------------------------

  describe('hot-reload', () => {
    it('watches the rules file, letting a settling write finish before reading it', () => {
      acl = new AccessControl(tmpDir);

      const watcher = chokidarSpy.latest();
      expect(watcher.watchedPath).toBe(path.join(tmpDir, 'access-rules.json'));
      // `awaitWriteFinish` is load-bearing: an editor saving in two syscalls
      // would otherwise be read half-written and quarantine the evaluator.
      expect(watcher.options).toMatchObject({
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });
    });

    it('reloads rules when the file changes on disk', () => {
      // Pre-create the file so chokidar watches an existing file (fires 'change' not 'add')
      writeRulesFile(tmpDir, []);
      acl = new AccessControl(tmpDir);

      // Initially no rules
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);

      writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]);
      chokidarSpy.latest().emit('change');

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    });

    it('picks up a rules file created after construction', () => {
      acl = new AccessControl(tmpDir);
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);

      writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]);
      chokidarSpy.latest().emit('add');

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    });

    // -----------------------------------------------------------------------
    // The one test in this file that uses a real chokidar watcher and waits on
    // the real platform.
    //
    // The hermetic tests above prove what the class does when told a file
    // changed. This proves it is ever told: that a watch on a single JSON path
    // fires at all, and that `whenWatcherReady()` is a gate a caller can
    // actually write against — the property the grace period inside it exists
    // for, and one no injected watcher can check.
    //
    // It walks all THREE handlers the class registers — `add`, `change`,
    // `unlink` — because they are three different chokidar code paths on a
    // single-file watch, and a real watcher that delivered only some of them
    // would leave the hermetic tests above passing over a broken class. That
    // costs no extra budget: each step is gated on the step before it having
    // been delivered.
    //
    // Exactly one write per step, on purpose. Re-writing to nudge a watcher
    // that missed the first one would turn a broken gate into a passing test,
    // which is the bug this is here to catch. The budget is generous instead.
    // -----------------------------------------------------------------------
    it('really does see a rules file appear, change and vanish under a real watcher', async () => {
      chokidarSpy.restore();
      // Start on an EMPTY directory so the first write is a real `add`.
      acl = new AccessControl(tmpDir);
      await acl.whenWatcherReady();

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);

      // add
      writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]);
      await waitUntil(
        () => !acl.checkAccess('relay.a', 'relay.b').allowed,
        'the newly created rules file to be picked up'
      );

      // change — a second rule against the now-existing file
      writeRulesFile(tmpDir, [makeRule('relay.x', 'relay.y', 'deny', 10)]);
      await waitUntil(
        () => acl.checkAccess('relay.a', 'relay.b').allowed,
        'the rewritten rules file to replace the first rule'
      );
      expect(acl.checkAccess('relay.x', 'relay.y').allowed).toBe(false);

      // unlink — deleting the file returns the machine to "nobody wrote a rule"
      fs.rmSync(path.join(tmpDir, 'access-rules.json'));
      await waitUntil(
        () => acl.checkAccess('relay.x', 'relay.y').allowed,
        'the deleted rules file to drop every rule'
      );
      expect(acl.listRules()).toEqual([]);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Unreadable rules — quarantine
  // -------------------------------------------------------------------------

  describe('a rules file that exists but cannot be read', () => {
    /** Write raw text (valid or not) to access-rules.json. */
    function writeRaw(dir: string, text: string): void {
      fs.writeFileSync(path.join(dir, 'access-rules.json'), text, 'utf-8');
    }

    it('denies every check when the JSON is truncated', () => {
      writeRaw(tmpDir, '[{"from":"relay.a","to":"relay.b","action":"deny","priority');
      acl = new AccessControl(tmpDir);

      expect(acl.isQuarantined()).toBe(true);
      const result = acl.checkAccess('relay.agent.projectA.backend', 'relay.human.telegram.t.1');
      expect(result.allowed).toBe(false);
      // The denial names the file, so an operator is told what to repair rather
      // than hunting for a rule that does not exist.
      expect(result.matchedRule).toBeUndefined();
      expect(result.reason).toContain('access-rules.json');
    });

    it('denies when the file holds something that is not a rule list', () => {
      writeRaw(tmpDir, '{"rules": []}');
      acl = new AccessControl(tmpDir);

      expect(acl.isQuarantined()).toBe(true);
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    });

    it('denies when one entry in an otherwise good file is not a rule', () => {
      // A rule we cannot read is as likely to be the deny protecting something
      // as anything else, so one bad entry quarantines rather than being dropped.
      writeRaw(
        tmpDir,
        JSON.stringify([
          { from: 'relay.a', to: 'relay.b', action: 'deny', priority: 10 },
          { from: 'relay.c', action: 'nonsense' },
        ])
      );
      acl = new AccessControl(tmpDir);

      expect(acl.isQuarantined()).toBe(true);
      expect(acl.checkAccess('relay.x', 'relay.y').allowed).toBe(false);
    });

    it('leaves the absent-file default-allow untouched', () => {
      // The pinned posture for "nobody has written a rule yet" is unchanged:
      // only a file that EXISTS and cannot be read fails closed.
      acl = new AccessControl(tmpDir);

      expect(acl.isQuarantined()).toBe(false);
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);
    });

    it('says so once, loudly', () => {
      const errors: unknown[][] = [];
      writeRaw(tmpDir, 'not json at all');
      acl = new AccessControl(tmpDir, { error: (...args) => errors.push(args) });

      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.[0])).toContain('Refusing to deliver');
    });

    it('recovers when the file is repaired', () => {
      writeRaw(tmpDir, '{{{');
      acl = new AccessControl(tmpDir);
      expect(acl.isQuarantined()).toBe(true);

      writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]);
      chokidarSpy.latest().emit('change');

      expect(acl.isQuarantined()).toBe(false);
      // The repaired rules are in effect, and unrelated traffic flows again.
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
      expect(acl.checkAccess('relay.x', 'relay.y').allowed).toBe(true);
    });

    it('refuses to add a rule, rather than overwriting the file it preserved', async () => {
      // A quarantined evaluator holds NO rules — it did not guess at what the
      // file said. Persisting from that state would write an empty list plus
      // the new rule, destroying the very file the quarantine exists to keep,
      // and would silently lift the quarantine because the result parses.
      writeRaw(tmpDir, '{{{');
      acl = new AccessControl(tmpDir);

      expect(() => acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10))).toThrow(
        /cannot be read/
      );
      // The unreadable file is untouched.
      expect(fs.readFileSync(path.join(tmpDir, 'access-rules.json'), 'utf-8')).toBe('{{{');
      expect(acl.isQuarantined()).toBe(true);
    });

    it('refuses to remove a rule for the same reason', async () => {
      writeRaw(tmpDir, '{{{');
      acl = new AccessControl(tmpDir);

      expect(() => acl.removeRule('relay.a', 'relay.b')).toThrow(/cannot be read/);
      expect(fs.readFileSync(path.join(tmpDir, 'access-rules.json'), 'utf-8')).toBe('{{{');
    });

    it('accepts writes again once the file is repaired', () => {
      writeRaw(tmpDir, '{{{');
      acl = new AccessControl(tmpDir);

      writeRulesFile(tmpDir, []);
      chokidarSpy.latest().emit('change');

      expect(() => acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10))).not.toThrow();
      expect(readRulesFile(tmpDir)).toHaveLength(1);
    });

    it('recovers when the broken file is deleted', () => {
      acl = new AccessControl(tmpDir);
      const watcher = chokidarSpy.latest();

      // The broken state is established THROUGH the watcher rather than at
      // construction, so this pins the `unlink` handler specifically: an
      // evaluator that quarantined at construction could be recovering because
      // of some other reload, while one that quarantined on `add` and recovered
      // on `unlink` can only have been driven by the two handlers under test.
      writeRaw(tmpDir, '{{{');
      watcher.emit('add');
      expect(acl.isQuarantined()).toBe(true);

      fs.rmSync(path.join(tmpDir, 'access-rules.json'));
      watcher.emit('unlink');

      expect(acl.isQuarantined()).toBe(false);
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Watcher error handling — an EMFILE-style watcher failure must be logged,
  // never swallowed nor left to the process-wide unhandled-error path.
  // -------------------------------------------------------------------------

  describe('watcher error handling', () => {
    it('logs a watcher error through the injected logger, naming the rules path', () => {
      const logger = createSpyLogger();
      acl = new AccessControl(tmpDir, logger);
      const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });

      chokidarSpy.latest().emit('error', err);

      // Two separate assertions rather than one interpolated RegExp: tmpDir is
      // a real filesystem path and could legally contain regex metacharacters
      // that would silently change what the pattern matches.
      const [message, context] = vi.mocked(logger.warn!).mock.calls[0]!;
      expect(typeof message).toBe('string');
      expect((message as string).startsWith('[watcher-error] AccessControl: ')).toBe(true);
      expect(message).toContain(tmpDir);
      expect(context).toEqual(
        expect.objectContaining({
          code: 'EMFILE',
          message: 'EMFILE: too many open files',
          stack: err.stack,
          suppressingFurtherErrors: true,
        })
      );
    });

    it('says further errors of that code are suppressed, so an operator knows the silence is by design', () => {
      const logger = createSpyLogger();
      acl = new AccessControl(tmpDir, logger);

      chokidarSpy.latest().emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('further EMFILE errors from this watcher are suppressed'),
        expect.objectContaining({ suppressingFurtherErrors: true })
      );
    });

    it('keeps enforcing already-loaded rules after a watcher error', () => {
      const rule = makeRule('relay.a', 'relay.b', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      chokidarSpy.latest().emit('error', new Error('EMFILE'));

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    });

    it('does not throw when no logger was injected', () => {
      acl = new AccessControl(tmpDir);

      expect(() => chokidarSpy.latest().emit('error', new Error('EMFILE'))).not.toThrow();
    });

    // A single fd-exhaustion episode can make chokidar fire 'error' many times
    // for one dead watcher. The handler must latch: log the first, drop repeats
    // of the same code.
    it('logs only the first of many errors carrying the same code', () => {
      const logger = createSpyLogger();
      acl = new AccessControl(tmpDir, logger);
      const watcher = chokidarSpy.latest();

      watcher.emit('error', Object.assign(new Error('EMFILE 1'), { code: 'EMFILE' }));
      watcher.emit('error', Object.assign(new Error('EMFILE 2'), { code: 'EMFILE' }));
      watcher.emit('error', Object.assign(new Error('EMFILE 3'), { code: 'EMFILE' }));

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE', message: 'EMFILE 1' })
      );
    });

    // The masking bug: a latch keyed on "any error at all" would let one benign
    // EACCES hide a real EMFILE storm that follows it. Keying on `code` means a
    // NEW code always gets its own line.
    it('logs a separate line for each distinct error code', () => {
      const logger = createSpyLogger();
      acl = new AccessControl(tmpDir, logger);
      const watcher = chokidarSpy.latest();

      watcher.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      watcher.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EACCES' })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE' })
      );
    });

    // Regression guard: if the latch were ever hoisted from the per-instance
    // closure onto a module-level field, one relay's first error would wrongly
    // suppress a second relay's first error too.
    it('scopes the latch per instance — two evaluators each log their own first error', () => {
      const loggerA = createSpyLogger();
      const loggerB = createSpyLogger();
      const otherDir = makeTmpDir();
      acl = new AccessControl(tmpDir, loggerA);
      const watcherA = chokidarSpy.latest();
      const aclB = new AccessControl(otherDir, loggerB);
      const watcherB = chokidarSpy.latest();
      try {
        watcherA.emit('error', Object.assign(new Error('EMFILE A'), { code: 'EMFILE' }));
        watcherB.emit('error', Object.assign(new Error('EMFILE B'), { code: 'EMFILE' }));

        expect(loggerA.warn).toHaveBeenCalledTimes(1);
        expect(loggerB.warn).toHaveBeenCalledTimes(1);
      } finally {
        aclB.close();
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // whenWatcherReady — the gate hot-reload callers use instead of sleeping.
  // Its happy path is exercised by the real-filesystem hot-reload test above;
  // what is pinned here is that it can never leave a caller waiting for an event
  // that is not coming. The injected watcher emits nothing on its own, so
  // `ready` is genuinely absent rather than merely early — a real watcher goes
  // ready within a millisecond and would settle these promises by itself,
  // passing whether or not the code under test did anything.
  // -------------------------------------------------------------------------

  describe('whenWatcherReady', () => {
    it('resolves when the watcher fails before it ever goes ready', async () => {
      acl = new AccessControl(tmpDir, createSpyLogger());

      // EMFILE and friends emit 'error' and no 'ready' at all. If startup were
      // settled only by 'ready', this await would never return.
      chokidarSpy.latest().emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));

      await expect(acl.whenWatcherReady()).resolves.toBeUndefined();
    });

    it('resolves when the evaluator is closed before the watcher goes ready', async () => {
      acl = new AccessControl(tmpDir);

      acl.close();

      await expect(acl.whenWatcherReady()).resolves.toBeUndefined();
    });

    it('resolves once the watcher goes ready', async () => {
      acl = new AccessControl(tmpDir);

      chokidarSpy.latest().emit('ready');

      await expect(acl.whenWatcherReady()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('stops the chokidar watcher', () => {
      acl = new AccessControl(tmpDir);
      const watcher = chokidarSpy.latest();

      acl.close();

      expect(watcher.closed).toBe(true);
    });

    it('is safe to call multiple times, and closes the watcher only once', () => {
      acl = new AccessControl(tmpDir);
      const watcher = chokidarSpy.latest();

      expect(() => {
        acl.close();
        acl.close();
        acl.close();
      }).not.toThrow();
      expect(watcher.closeCount).toBe(1);
    });
  });
});
