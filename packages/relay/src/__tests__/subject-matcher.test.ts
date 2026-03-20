import { describe, it, expect } from 'vitest';
import { matchesPattern, validateSubject } from '../subject-matcher.js';

// ============================================================
// matchesPattern
// ============================================================

describe('matchesPattern', () => {
  // ----------------------------------------------------------
  // Literal (exact) matching
  // ----------------------------------------------------------

  describe('literal matching', () => {
    it('matches identical single-token subjects', () => {
      expect(matchesPattern('hello', 'hello')).toBe(true);
    });

    it('matches identical multi-token subjects', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.agent.myproject.backend')).toBe(
        true
      );
    });

    it('does not match different single-token subjects', () => {
      expect(matchesPattern('hello', 'world')).toBe(false);
    });

    it('does not match when subject has fewer tokens than literal pattern', () => {
      expect(matchesPattern('relay.agent', 'relay.agent.myproject')).toBe(false);
    });

    it('does not match when subject has more tokens than literal pattern', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.agent.myproject')).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(matchesPattern('Relay.Agent', 'relay.agent')).toBe(false);
      expect(matchesPattern('relay.agent', 'Relay.Agent')).toBe(false);
    });

    it('distinguishes hyphens and underscores in tokens', () => {
      expect(matchesPattern('my-project', 'my_project')).toBe(false);
      expect(matchesPattern('my-project', 'my-project')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // Single-token wildcard `*`
  // ----------------------------------------------------------

  describe('* wildcard (single token)', () => {
    it('matches any single token', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.agent.myproject.*')).toBe(true);
      expect(matchesPattern('relay.agent.myproject.frontend', 'relay.agent.myproject.*')).toBe(
        true
      );
    });

    it('matches `*` at the start of a pattern', () => {
      expect(matchesPattern('relay.agent.myproject.backend', '*.agent.myproject.backend')).toBe(
        true
      );
    });

    it('matches `*` in the middle of a pattern', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.*.myproject.backend')).toBe(
        true
      );
    });

    it('matches multiple `*` wildcards in a single pattern', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.*.*.backend')).toBe(true);
    });

    it('does NOT match across multiple tokens', () => {
      // `*` only covers one token; extra subject tokens cause no-match
      expect(matchesPattern('relay.agent.myproject', 'relay.*')).toBe(false);
    });

    it('does NOT match zero tokens', () => {
      // A `*`-only pattern should require exactly one token in the subject
      expect(matchesPattern('', '*')).toBe(false);
    });

    it('matches exactly one token (single-token subject against *)', () => {
      expect(matchesPattern('hello', '*')).toBe(true);
    });

    it('does not match when token counts differ with *', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.*')).toBe(false);
    });

    it('handles all-wildcard pattern with matching token count', () => {
      expect(matchesPattern('a.b.c', '*.*.*')).toBe(true);
      expect(matchesPattern('a.b', '*.*.*')).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Multi-token wildcard `>`
  // ----------------------------------------------------------

  describe('> wildcard (multi-token / rest)', () => {
    it('matches one remaining token', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.agent.myproject.>')).toBe(true);
    });

    it('matches multiple remaining tokens', () => {
      // subject has 4 tokens; pattern covers first 2, `>` covers remaining 2
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.agent.>')).toBe(true);
    });

    it('matches from the root', () => {
      expect(matchesPattern('relay.agent.myproject.backend', '>')).toBe(true);
    });

    it('matches all subjects of any depth', () => {
      expect(matchesPattern('a', '>')).toBe(true);
      expect(matchesPattern('a.b', '>')).toBe(true);
      expect(matchesPattern('a.b.c.d.e', '>')).toBe(true);
    });

    it('does NOT match zero remaining tokens', () => {
      // pattern `relay.agent.myproject.backend.>` requires at least one token after `backend`
      expect(
        matchesPattern('relay.agent.myproject.backend', 'relay.agent.myproject.backend.>')
      ).toBe(false);
    });

    it('matches when combined with * wildcards', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.*.*.*')).toBe(true);
      // `relay.*.>` — first `*` covers `agent`, `>` covers the rest (2 tokens)
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.*.>')).toBe(true);
    });

    it('uses > at end to match varying depths', () => {
      const pattern = 'relay.human.telegram.>';
      expect(matchesPattern('relay.human.telegram.dorian', pattern)).toBe(true);
      expect(matchesPattern('relay.human.telegram.dorian.extra', pattern)).toBe(true);
      expect(matchesPattern('relay.human.slack.dorian', pattern)).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Combined wildcard edge cases
  // ----------------------------------------------------------

  describe('combined wildcard cases', () => {
    it('pattern `relay.*.*.error` matches agent error subjects', () => {
      expect(matchesPattern('relay.agent.myproject.error', 'relay.*.*.error')).toBe(true);
      expect(matchesPattern('relay.agent.otherproject.error', 'relay.*.*.error')).toBe(true);
      expect(matchesPattern('relay.agent.myproject.success', 'relay.*.*.error')).toBe(false);
    });

    it('pattern with both `*` and `>` resolves correctly', () => {
      // `relay.*.>` — first wildcard matches `agent`, `>` covers `myproject.backend`
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.*.>')).toBe(true);
    });

    it('subject with numeric tokens matches literal pattern', () => {
      expect(matchesPattern('relay.agent.123.456', 'relay.agent.123.456')).toBe(true);
    });

    it('single-token subject matches single-token pattern', () => {
      expect(matchesPattern('relay', 'relay')).toBe(true);
      expect(matchesPattern('relay', '*')).toBe(true);
      expect(matchesPattern('relay', '>')).toBe(true);
    });

    it('two-token subject against two-token pattern', () => {
      expect(matchesPattern('relay.agent', 'relay.agent')).toBe(true);
      expect(matchesPattern('relay.agent', '*.agent')).toBe(true);
      expect(matchesPattern('relay.agent', 'relay.*')).toBe(true);
      expect(matchesPattern('relay.agent', '*.*')).toBe(true);
      expect(matchesPattern('relay.agent', 'relay.>')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // Real-world relay subject examples
  // ----------------------------------------------------------

  describe('real-world relay subjects', () => {
    it('point-to-point: exact agent subject', () => {
      const subject = 'relay.agent.myproject.backend';
      expect(matchesPattern(subject, 'relay.agent.myproject.backend')).toBe(true);
      expect(matchesPattern(subject, 'relay.agent.myproject.frontend')).toBe(false);
    });

    it('pub/sub: all agents in a project', () => {
      const pattern = 'relay.agent.myproject.*';
      expect(matchesPattern('relay.agent.myproject.backend', pattern)).toBe(true);
      expect(matchesPattern('relay.agent.myproject.frontend', pattern)).toBe(true);
      expect(matchesPattern('relay.agent.other.backend', pattern)).toBe(false);
    });

    it('pub/sub: all telegram users', () => {
      const pattern = 'relay.human.telegram.>';
      expect(matchesPattern('relay.human.telegram.dorian', pattern)).toBe(true);
      expect(matchesPattern('relay.human.telegram.alice', pattern)).toBe(true);
      expect(matchesPattern('relay.human.slack.dorian', pattern)).toBe(false);
    });

    it('pub/sub: all agent errors across all projects', () => {
      const pattern = 'relay.agent.*.*.error';
      expect(matchesPattern('relay.agent.myproject.backend.error', pattern)).toBe(true);
      expect(matchesPattern('relay.agent.other.frontend.error', pattern)).toBe(true);
      expect(matchesPattern('relay.agent.myproject.backend.success', pattern)).toBe(false);
    });

    it('system service subscription', () => {
      const pattern = 'relay.system.>';
      expect(matchesPattern('relay.system.pulse.scheduler', pattern)).toBe(true);
      expect(matchesPattern('relay.system.health.checker', pattern)).toBe(true);
      expect(matchesPattern('relay.agent.myproject.backend', pattern)).toBe(false);
    });
  });
});

// ============================================================
// validateSubject
// ============================================================

describe('validateSubject', () => {
  // ----------------------------------------------------------
  // Valid subjects and patterns
  // ----------------------------------------------------------

  describe('valid inputs', () => {
    it('accepts a simple single-token subject', () => {
      expect(validateSubject('relay')).toEqual({ valid: true });
    });

    it('accepts a multi-token subject', () => {
      expect(validateSubject('relay.agent.myproject.backend')).toEqual({ valid: true });
    });

    it('accepts the `*` wildcard', () => {
      expect(validateSubject('relay.agent.*')).toEqual({ valid: true });
    });

    it('accepts the `>` wildcard as the final token', () => {
      expect(validateSubject('relay.agent.>')).toEqual({ valid: true });
    });

    it('accepts `>` as the only token', () => {
      expect(validateSubject('>')).toEqual({ valid: true });
    });

    it('accepts `*` as the only token', () => {
      expect(validateSubject('*')).toEqual({ valid: true });
    });

    it('accepts multiple `*` wildcards', () => {
      expect(validateSubject('relay.*.*.error')).toEqual({ valid: true });
    });

    it('accepts tokens with hyphens', () => {
      expect(validateSubject('relay.my-project.backend')).toEqual({ valid: true });
    });

    it('accepts tokens with underscores', () => {
      expect(validateSubject('relay.my_project.backend_service')).toEqual({ valid: true });
    });

    it('accepts numeric tokens', () => {
      expect(validateSubject('relay.agent.123')).toEqual({ valid: true });
    });

    it('accepts mixed alphanumeric tokens', () => {
      expect(validateSubject('relay.agent.project1.service2')).toEqual({ valid: true });
    });

    it('accepts a pattern with `*` before `>`', () => {
      expect(validateSubject('relay.*.>')).toEqual({ valid: true });
    });

    it('accepts exactly MAX_TOKEN_COUNT (16) tokens', () => {
      const tokens = Array.from({ length: 16 }, (_, i) => `t${i}`);
      expect(validateSubject(tokens.join('.'))).toEqual({ valid: true });
    });
  });

  // ----------------------------------------------------------
  // Invalid inputs
  // ----------------------------------------------------------

  describe('invalid inputs', () => {
    it('rejects an empty string', () => {
      const result = validateSubject('');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/non-empty/i);
      }
    });

    it('rejects a string with an empty token (leading dot)', () => {
      const result = validateSubject('.relay.agent');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/empty token/i);
      }
    });

    it('rejects a string with an empty token (trailing dot)', () => {
      const result = validateSubject('relay.agent.');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/empty token/i);
      }
    });

    it('rejects a string with an empty token (consecutive dots)', () => {
      const result = validateSubject('relay..agent');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/empty token/i);
      }
    });

    it('rejects `>` when not the last token', () => {
      const result = validateSubject('relay.>.agent');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/last token/i);
      }
    });

    it('rejects `>` at the start when not the only token', () => {
      const result = validateSubject('>.relay.agent');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/last token/i);
      }
    });

    it('rejects tokens with spaces', () => {
      const result = validateSubject('relay.my project.backend');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/invalid characters/i);
      }
    });

    it('rejects tokens with special characters', () => {
      const result = validateSubject('relay.agent@host.backend');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/invalid characters/i);
      }
    });

    it('rejects tokens with slashes', () => {
      const result = validateSubject('relay/agent/backend');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/invalid characters/i);
      }
    });

    it('rejects subjects exceeding MAX_TOKEN_COUNT', () => {
      const tokens = Array.from({ length: 17 }, (_, i) => `t${i}`);
      const result = validateSubject(tokens.join('.'));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/maximum token count/i);
      }
    });

    it('includes the original subject in the error reason', () => {
      const badSubject = 'relay..agent';
      const result = validateSubject(badSubject);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.subject).toBe(badSubject);
      }
    });
  });
});
