import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccessControl } from '../access-control.js';
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';

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

    it('handles corrupt JSON gracefully (defaults to empty rules)', () => {
      fs.writeFileSync(path.join(tmpDir, 'access-rules.json'), '{not valid json', 'utf-8');

      acl = new AccessControl(tmpDir);

      expect(acl.checkAccess('relay.any', 'relay.other').allowed).toBe(true);
      expect(acl.listRules()).toEqual([]);
    });

    it('handles non-array JSON gracefully (defaults to empty rules)', () => {
      fs.writeFileSync(path.join(tmpDir, 'access-rules.json'), '{"not": "array"}', 'utf-8');

      acl = new AccessControl(tmpDir);

      expect(acl.listRules()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Hot-reload via chokidar
  // -------------------------------------------------------------------------

  describe('hot-reload', () => {
    it('reloads rules when the file changes on disk', async () => {
      // Pre-create the file so chokidar watches an existing file (fires 'change' not 'add')
      writeRulesFile(tmpDir, []);
      acl = new AccessControl(tmpDir);

      // Give chokidar time to initialize its watcher
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Initially no rules
      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(true);

      // Write a deny rule externally
      writeRulesFile(tmpDir, [makeRule('relay.a', 'relay.b', 'deny', 10)]);

      // Poll until chokidar detects the change
      // awaitWriteFinish: stabilityThreshold=100ms + pollInterval=50ms + chokidar overhead
      const maxWaitMs = 3000;
      const pollMs = 100;
      const start = Date.now();

      while (Date.now() - start < maxWaitMs) {
        if (!acl.checkAccess('relay.a', 'relay.b').allowed) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      expect(acl.checkAccess('relay.a', 'relay.b').allowed).toBe(false);
    }, 10_000);
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
