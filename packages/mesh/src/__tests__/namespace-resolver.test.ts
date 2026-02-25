import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  normalizeNamespace,
  validateNamespace,
  resolveNamespace,
} from '../namespace-resolver.js';

// ---------------------------------------------------------------------------
// normalizeNamespace
// ---------------------------------------------------------------------------

describe('normalizeNamespace', () => {
  it('lowercases uppercase letters', () => {
    expect(normalizeNamespace('HELLO')).toBe('hello');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeNamespace('Hello World!')).toBe('hello-world');
  });

  it('collapses multiple hyphens', () => {
    expect(normalizeNamespace('---foo---')).toBe('foo');
  });

  it('replaces underscores and dots with hyphens', () => {
    expect(normalizeNamespace('FOO_BAR.baz')).toBe('foo-bar-baz');
  });

  it('preserves existing hyphens between words', () => {
    expect(normalizeNamespace('team-a')).toBe('team-a');
  });

  it('handles alphanumeric input unchanged', () => {
    expect(normalizeNamespace('dorkos123')).toBe('dorkos123');
  });
});

// ---------------------------------------------------------------------------
// validateNamespace
// ---------------------------------------------------------------------------

describe('validateNamespace', () => {
  it('returns valid: false for empty string', () => {
    const result = validateNamespace('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/empty/i);
    }
  });

  it('returns valid: false for string longer than 64 chars', () => {
    const result = validateNamespace('a'.repeat(65));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/64/);
    }
  });

  it('returns valid: true for exactly 64 chars', () => {
    expect(validateNamespace('a'.repeat(64))).toEqual({ valid: true });
  });

  it('returns valid: true for a normal namespace', () => {
    expect(validateNamespace('valid-ns')).toEqual({ valid: true });
  });

  it('returns valid: true for a single character', () => {
    expect(validateNamespace('x')).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// resolveNamespace — manifest override
// ---------------------------------------------------------------------------

describe('resolveNamespace — manifest override', () => {
  it('uses manifestNamespace when provided', () => {
    expect(resolveNamespace('/any/path', '/any', 'custom-ns')).toBe('custom-ns');
  });

  it('normalizes manifestNamespace before returning', () => {
    expect(resolveNamespace('/any/path', '/any', 'Custom NS!')).toBe('custom-ns');
  });

  it('ignores empty-string manifestNamespace and falls back to path derivation', () => {
    const result = resolveNamespace('/projects/my-agent', '/projects', '');
    expect(result).toBe('my-agent');
  });

  it('ignores whitespace-only manifestNamespace and falls back to path derivation', () => {
    const result = resolveNamespace('/projects/my-agent', '/projects', '   ');
    expect(result).toBe('my-agent');
  });

  it('throws for manifestNamespace that normalizes to empty string', () => {
    expect(() => resolveNamespace('/any/path', '/any', '---')).toThrow(
      /Invalid manifest namespace/,
    );
  });

  it('throws for manifestNamespace that exceeds 64 chars after normalization', () => {
    const longNs = 'a'.repeat(65);
    expect(() => resolveNamespace('/any/path', '/any', longNs)).toThrow(
      /Invalid manifest namespace/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveNamespace — path derivation
// ---------------------------------------------------------------------------

describe('resolveNamespace — path derivation', () => {
  const home = '/home/user';

  it('returns first path segment relative to scanRoot', () => {
    expect(resolveNamespace(`${home}/projects/dorkos`, `${home}/projects`)).toBe('dorkos');
  });

  it('returns first segment even for deeply nested paths', () => {
    expect(resolveNamespace(`${home}/projects/dorkos/core`, `${home}/projects`)).toBe('dorkos');
  });

  it('handles hyphenated directory names', () => {
    expect(resolveNamespace(`${home}/projects/team-a`, `${home}/projects`)).toBe('team-a');
  });

  it('normalizes the derived segment', () => {
    // A directory named "My_Agent" should become "my-agent"
    expect(resolveNamespace(`${home}/work/My_Agent`, `${home}/work`)).toBe('my-agent');
  });

  it('handles single-level nesting', () => {
    expect(resolveNamespace(`${home}/work/my-agent`, `${home}/work`)).toBe('my-agent');
  });

  it('throws when projectPath equals scanRoot (empty relative path)', () => {
    expect(() => resolveNamespace(`${home}/projects`, `${home}/projects`)).toThrow(
      /Cannot derive namespace/,
    );
  });

  it('throws when projectPath is above scanRoot', () => {
    // path.relative produces '../..' style paths; '..' normalizes to empty, triggering a validation error
    expect(() => resolveNamespace(`${home}`, `${home}/projects`)).toThrow(/namespace/i);
  });

  it('handles trailing slash on scanRoot by normalizing via path.join', () => {
    // path.relative handles trailing slashes correctly on the platform
    const scanRoot = path.join('/projects') + path.sep;
    const projectPath = path.join('/projects', 'my-agent');
    // Should still derive 'my-agent' without throwing
    const result = resolveNamespace(projectPath, scanRoot);
    expect(result).toBe('my-agent');
  });
});
