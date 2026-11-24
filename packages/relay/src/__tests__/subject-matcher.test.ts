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

    it('does not match different single-token subjects', () => {
      expect(matchesPattern('hello', 'world')).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(matchesPattern('Relay.Agent', 'relay.agent')).toBe(false);
      expect(matchesPattern('relay.agent', 'Relay.Agent')).toBe(false);
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

    it('does NOT match across multiple tokens', () => {
      // `*` only covers one token; extra subject tokens cause no-match
      expect(matchesPattern('relay.agent.myproject', 'relay.*')).toBe(false);
    });

    it('does NOT match zero tokens', () => {
      // A `*`-only pattern should require exactly one token in the subject
      expect(matchesPattern('', '*')).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Multi-token wildcard `>`
  // ----------------------------------------------------------

  describe('> wildcard (multi-token / rest)', () => {
    it('matches one remaining token', () => {
      expect(matchesPattern('relay.agent.myproject.backend', 'relay.agent.myproject.>')).toBe(true);
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
  });

  // ----------------------------------------------------------
  // Combined wildcard edge cases
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // Real-world relay subject examples
  // ----------------------------------------------------------
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

    it('accepts the `>` wildcard as the final token', () => {
      expect(validateSubject('relay.agent.>')).toEqual({ valid: true });
    });

    it('accepts tokens with hyphens', () => {
      expect(validateSubject('relay.my-project.backend')).toEqual({ valid: true });
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

    it('rejects `>` when not the last token', () => {
      const result = validateSubject('relay.>.agent');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/last token/i);
      }
    });

    it.each(['relay.my project.backend', 'relay.agent@host.backend', 'relay/agent/backend'])(
      'rejects tokens with invalid characters: %s',
      (subject) => {
        const result = validateSubject(subject);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason.message).toMatch(/invalid characters/i);
        }
      }
    );

    it('rejects subjects exceeding MAX_TOKEN_COUNT', () => {
      const tokens = Array.from({ length: 17 }, (_, i) => `t${i}`);
      const result = validateSubject(tokens.join('.'));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.message).toMatch(/maximum token count/i);
      }
    });
  });
});
