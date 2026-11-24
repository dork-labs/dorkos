/**
 * Tests for {@link AccessControl}.
 *
 * Rule evaluation is synchronous and file-backed, so most of this file is
 * ordinary. The watcher is not: by default every test here runs against an
 * INJECTED watcher it drives itself (see `./fake-watcher.ts`), because polling a
 * hand-rolled deadline for a real fs event measures the machine's latency rather
 * than this class's behaviour, and went red under multi-agent load (DOR-1777).
 * Exactly one test — the last in the `hot-reload` block — puts the real chokidar
 * back over a real file, and it is the only wall-clock bound in the file. It
 * runs that watch on chokidar's POLLING backend, which is what makes it a fact
 * about this class rather than a wager on how macOS feels today; the reasoning
 * and the measurements are at `watchWithPolling` in `./fake-watcher.ts`.
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
import { interceptChokidar, watchWithPolling, type ChokidarInterceptor } from './fake-watcher.js';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';

/** A spy logger satisfying the {@link AccessControlLogger} surface. */
function createSpyLogger(): AccessControlLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

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
 * How long the one real-filesystem case gives the watcher, per step.
 *
 * Deliberately generous and deliberately alone: it is the only wall-clock bound
 * left in this file, and it is paid in full only when the watcher is broken.
 * Everywhere else the watcher is injected and there is nothing to wait for.
 *
 * Scaled by load, and sampled when the wait starts rather than at import. A
 * budget frozen at module load reads the one-minute average from before the
 * sweep that needed it began, which is exactly the case the pre-push gate hits.
 */
const REAL_RELOAD_BASE_MS = 10_000;
/** How often chokidar re-stats the rules file, and how often this file re-checks. */
const WATCH_POLL_MS = 50;
const RELOAD_POLL_MS = 50;
/**
 * The real-filesystem case's own ceiling.
 *
 * Sized from the WORST its waits can grow to, not from the load at import: a
 * runner fixes a test's timeout when the test is defined and cannot resample
 * later. Three steps, plus slack for setup and teardown, and capped absolutely
 * so no single test can sit for minutes before saying anything.
 */
const REAL_WATCH_TEST_TIMEOUT_MS = Math.min(
  120_000,
  3 * loadCeilingMs(REAL_RELOAD_BASE_MS) + 20_000
);

/**
 * Poll until `predicate` holds, or fail loudly.
 *
 * The change under test is made exactly once, before this is called; only its
 * observation is outstanding. That single change is enough BECAUSE the watch
 * under this case polls: a `stat` on an interval does not drop anything, so a
 * change that is not picked up was not picked up. Under a native watch it would
 * not be enough, and no amount of budget would make it so — see
 * {@link watchWithPolling} for the measurements.
 *
 * @param predicate - The condition being waited on.
 * @param what - Named in the failure message, so a timeout says what was lost.
 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + loadScaledMs(REAL_RELOAD_BASE_MS);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(RELOAD_POLL_MS);
  }
  if (predicate()) return;
  throw new Error(`timed out waiting for ${what}`);
}

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
  });

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
  });

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
  });

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
  });

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

    it('keeps rules added at runtime in priority order, so a later high-priority allow wins', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.agent.>', 'relay.agent.>', 'deny', 5));
      acl.addRule(makeRule('relay.agent.trusted.*', 'relay.agent.>', 'allow', 20));

      expect(acl.listRules().map((r) => r.priority)).toEqual([20, 5]);
      expect(acl.checkAccess('relay.agent.trusted.bot', 'relay.agent.x.worker').allowed).toBe(true);
    });

    it('replaces duplicate rules with same from/to/priority', () => {
      acl = new AccessControl(tmpDir);

      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10));
      acl.addRule(makeRule('relay.a', 'relay.b', 'allow', 10));

      const rules = acl.listRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('allow');
    });

    it('writes nothing when the same rule is asserted again (DOR-2900)', () => {
      // Mesh re-asserts every agent's default rules on every reconcile pass;
      // each needless write also woke this file's own watcher into a reload.
      acl = new AccessControl(tmpDir);
      acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10));
      const file = path.join(tmpDir, 'access-rules.json');
      const before = fs.statSync(file);

      for (let i = 0; i < 5; i++) acl.addRule(makeRule('relay.a', 'relay.b', 'deny', 10));

      const after = fs.statSync(file);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(acl.listRules()).toHaveLength(1);
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
  });

  describe('file loading', () => {
    it('loads rules from an existing access-rules.json on construction', () => {
      const rule = makeRule('relay.sender', 'relay.receiver', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);

      acl = new AccessControl(tmpDir);

      expect(acl.checkAccess('relay.sender', 'relay.receiver').allowed).toBe(false);
    });

    // Corrupt and non-array files used to load as "no rules", i.e. as
    // default-allow. They now quarantine — see the fail-closed block below.
  });

  describe('hot-reload', () => {
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

    // -----------------------------------------------------------------------
    // The one test in this file that uses a real chokidar watcher and a real
    // file on a real disk.
    //
    // The hermetic tests above are the always-asserted twin, and they are what
    // this file's coverage rests on: they drive an injected watcher, so they run
    // and assert on every machine whatever the platform is doing, and a handler
    // that stops reloading reds there first. Read them as the guarantee and this
    // case as the extra — it proves the class is ever TOLD: that chokidar, given
    // the options `AccessControl` actually passes, reports a single JSON path
    // appearing, changing and vanishing, and that `whenWatcherReady()` is a gate
    // a caller can write against. No injected watcher can check any of that.
    //
    // It walks all THREE handlers the class registers — `add`, `change`,
    // `unlink` — because they are three different chokidar code paths on a
    // single-file watch, and a real watcher that delivered only some of them
    // would leave the hermetic tests above passing over a broken class.
    //
    // THE WATCH POLLS, and that is the one substitution in an otherwise
    // end-to-end case. It is what makes this deterministic instead of a wager on
    // macOS: under a native watch, a single write is reported only sometimes —
    // as few as 2 windows in 7 from inside a Vitest worker on a loaded machine —
    // so "the file was created and nothing happened" cannot tell a broken
    // handler from a dropped event, and this case reddened healthy code twice in
    // eight runs before it polled (DOR-2012 review, finding 1). What is given up
    // is narrow and named in `watchWithPolling`; `watcher-manager.test.ts` is
    // where a native chokidar delivery is still exercised.
    // -----------------------------------------------------------------------
    it(
      'really does see a rules file appear, change and vanish under a real watcher',
      async () => {
        chokidarSpy.restore();
        const polling = watchWithPolling(WATCH_POLL_MS);
        const rulesPath = path.join(tmpDir, 'access-rules.json');

        try {
          // Start on an EMPTY directory so the first write is a real `add`.
          acl = new AccessControl(tmpDir, createSpyLogger());
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
          fs.rmSync(rulesPath);
          await waitUntil(
            () => acl.checkAccess('relay.x', 'relay.y').allowed,
            'the deleted rules file to drop every rule'
          );
          expect(acl.listRules()).toEqual([]);
        } finally {
          polling.restore();
        }
      },
      REAL_WATCH_TEST_TIMEOUT_MS
    );
  });

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
  describe('watcher error handling', () => {
    it('keeps enforcing already-loaded rules after a watcher error', () => {
      const rule = makeRule('relay.a', 'relay.b', 'deny', 10);
      writeRulesFile(tmpDir, [rule]);
      acl = new AccessControl(tmpDir);

      chokidarSpy.latest().emit('error', new Error('EMFILE'));

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
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
  });
});
