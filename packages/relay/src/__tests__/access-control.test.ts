import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import { AccessControl, RULES_WRITE_STABILITY_MS } from '../access-control.js';
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type { AccessControlLogger } from '../access-control.js';

/** Reach into the private chokidar watcher to simulate an EMFILE-style failure. */
function getWatcher(acl: AccessControl): EventEmitter {
  return (acl as unknown as { watcher: EventEmitter }).watcher;
}

/**
 * Replace chokidar with a watcher that never reaches `ready`.
 *
 * A real watcher goes ready within a millisecond of construction, so it cannot
 * hold open the two cases below — a failure before readiness, and a close that
 * beats it. Restored by `vi.restoreAllMocks()` in `afterEach`.
 */
function useNeverReadyWatcher(): EventEmitter {
  const fake = Object.assign(new EventEmitter(), { close: () => Promise.resolve() });
  vi.spyOn(chokidar, 'watch').mockReturnValue(fake as unknown as FSWatcher);
  return fake;
}

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

/** How long the hot-reload helpers below give the watcher before giving up. */
const RELOAD_TIMEOUT_MS = 5000;
/**
 * How long each helper round waits before re-checking.
 *
 * Derived from the watcher's own stability threshold rather than picked: a
 * repeated write must leave the file untouched for longer than that threshold,
 * or `awaitWriteFinish` keeps restarting its timer and never emits anything.
 */
const RELOAD_POLL_MS = RULES_WRITE_STABILITY_MS + 150;

/**
 * Poll until `predicate` holds, or fail loudly.
 *
 * Used where the change under test has already been made and only its
 * observation is outstanding — never as a stand-in for a fixed sleep.
 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(RELOAD_POLL_MS);
  }
  throw new Error(`timed out after ${RELOAD_TIMEOUT_MS}ms waiting for ${what}`);
}

/**
 * Drive a hot-reload: apply `stimulus`, and re-apply it until `predicate` holds.
 *
 * `AccessControl.whenWatcherReady()` says the watcher has attached, which is
 * the gate these tests need in place of a sleep — but attached is not yet
 * delivering. Measured on macOS with chokidar 5: a write issued in the same
 * tick as `ready` is dropped outright, one issued 5ms later always arrives. A
 * dropped event never arrives late, so polling alone would burn the whole
 * timeout. Re-applying closes that window without guessing at a duration, so
 * `stimulus` must be idempotent — writing the same bytes again.
 *
 * The re-apply comes after the check, never before, so a run that succeeds on
 * the first stimulus leaves no second write in flight to reload the evaluator
 * again behind the test's back.
 */
async function waitForReload(
  stimulus: () => void,
  predicate: () => boolean,
  what: string
): Promise<void> {
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  stimulus();
  while (Date.now() < deadline) {
    await wait(RELOAD_POLL_MS);
    if (predicate()) return;
    stimulus();
  }
  throw new Error(`timed out after ${RELOAD_TIMEOUT_MS}ms waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccessControl', () => {
  let tmpDir: string;
  let acl: AccessControl;

  beforeEach(() => {
    tmpDir = makeTmpDir();
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
    it('reloads rules when the file changes on disk', async () => {
      // Pre-create the file so chokidar watches an existing file (fires 'change' not 'add')
      writeRulesFile(tmpDir, []);
      acl = new AccessControl(tmpDir);
      await acl.whenWatcherReady();

      // Initially no rules
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);

      // Write a deny rule externally
      await waitForReload(
        () => writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]),
        () => !acl.checkAccess('relay.a', 'relay.b').allowed,
        'the externally written deny rule to be picked up'
      );

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    }, 10_000);
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

    it('recovers when the file is repaired', async () => {
      writeRaw(tmpDir, '{{{');
      acl = new AccessControl(tmpDir);
      expect(acl.isQuarantined()).toBe(true);

      await acl.whenWatcherReady();
      await waitForReload(
        () => writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]),
        () => !acl.isQuarantined(),
        'the quarantine to lift after the file was repaired'
      );

      expect(acl.isQuarantined()).toBe(false);
      // The repaired rules are in effect, and unrelated traffic flows again.
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
      expect(acl.checkAccess('relay.x', 'relay.y').allowed).toBe(true);
    }, 10_000);

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

    it('accepts writes again once the file is repaired', async () => {
      writeRaw(tmpDir, '{{{');
      acl = new AccessControl(tmpDir);

      await acl.whenWatcherReady();
      await waitForReload(
        () => writeRulesFile(tmpDir, []),
        () => !acl.isQuarantined(),
        'the quarantine to lift after the file was repaired'
      );

      expect(() => acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10))).not.toThrow();
      expect(readRulesFile(tmpDir)).toHaveLength(1);
    }, 10_000);

    it('recovers when the broken file is deleted', async () => {
      acl = new AccessControl(tmpDir);
      await acl.whenWatcherReady();

      // The broken state is established THROUGH the watcher rather than at
      // construction, because a deletion cannot be re-applied the way a write
      // can: `rm` on an already-absent file emits nothing, so if the unlink
      // were lost in the attach window there would be no second chance. A
      // write the watcher demonstrably saw proves it is delivering, and the
      // deletion below is then safe to make exactly once.
      await waitForReload(
        () => writeRaw(tmpDir, '{{{'),
        () => acl.isQuarantined(),
        'the broken file to quarantine the evaluator'
      );

      fs.rmSync(path.join(tmpDir, 'access-rules.json'));
      await waitUntil(
        () => !acl.isQuarantined(),
        'the quarantine to lift after the file was deleted'
      );

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);
    }, 10_000);
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

      getWatcher(acl).emit('error', err);

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

      getWatcher(acl).emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('further EMFILE errors from this watcher are suppressed'),
        expect.objectContaining({ suppressingFurtherErrors: true })
      );
    });

    it('keeps enforcing already-loaded rules after a watcher error', () => {
      const rule = makeRule('relay.a', 'relay.b', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      getWatcher(acl).emit('error', new Error('EMFILE'));

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    });

    it('does not throw when no logger was injected', () => {
      acl = new AccessControl(tmpDir);

      expect(() => getWatcher(acl).emit('error', new Error('EMFILE'))).not.toThrow();
    });

    // A single fd-exhaustion episode can make chokidar fire 'error' many times
    // for one dead watcher. The handler must latch: log the first, drop repeats
    // of the same code.
    it('logs only the first of many errors carrying the same code', () => {
      const logger = createSpyLogger();
      acl = new AccessControl(tmpDir, logger);
      const watcher = getWatcher(acl);

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
      const watcher = getWatcher(acl);

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
      const aclB = new AccessControl(otherDir, loggerB);
      try {
        getWatcher(acl).emit('error', Object.assign(new Error('EMFILE A'), { code: 'EMFILE' }));
        getWatcher(aclB).emit('error', Object.assign(new Error('EMFILE B'), { code: 'EMFILE' }));

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
  // Its happy path is exercised by every hot-reload test above; what is pinned
  // here is that it can never leave a caller waiting for an event that is not
  // coming.
  // -------------------------------------------------------------------------

  describe('whenWatcherReady', () => {
    it('resolves when the watcher fails before it ever goes ready', async () => {
      const fake = useNeverReadyWatcher();
      acl = new AccessControl(tmpDir, createSpyLogger());

      // EMFILE and friends emit 'error' and no 'ready' at all. If startup were
      // settled only by 'ready', this await would never return.
      fake.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));

      await expect(acl.whenWatcherReady()).resolves.toBeUndefined();
    });

    it('resolves when the evaluator is closed before the watcher goes ready', async () => {
      useNeverReadyWatcher();
      acl = new AccessControl(tmpDir);

      acl.close();

      await expect(acl.whenWatcherReady()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('stops the chokidar watcher', () => {
      acl = new AccessControl(tmpDir);
      acl.close();

      // Should not throw when calling close again
      acl.close();
    });

    it('is safe to call multiple times', () => {
      acl = new AccessControl(tmpDir);

      expect(() => {
        acl.close();
        acl.close();
        acl.close();
      }).not.toThrow();
    });
  });
});
