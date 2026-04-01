import { describe, it, expect } from 'vitest';
import { CommandFrontmatterSchema } from '../command-schema.js';

describe('CommandFrontmatterSchema', () => {
  const base = { name: 'deploy', description: 'Deploy to production' };

  it('accepts all base fields plus command-specific fields', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      'argument-hint': '[environment]',
      'disable-model-invocation': true,
      'user-invocable': true,
      context: 'fork',
      agent: 'codegen',
      model: 'claude-sonnet-4-20250514',
      effort: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults (user-invocable=true)', () => {
    const result = CommandFrontmatterSchema.parse(base);
    expect(result['user-invocable']).toBe(true);
  });

  it('accepts argument-hint', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      'argument-hint': '[issue-number]',
    });
    expect(result.success).toBe(true);
  });

  it('accepts disable-model-invocation', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      'disable-model-invocation': true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts context "fork" with agent', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      context: 'fork',
      agent: 'codegen',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid effort values', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      const result = CommandFrontmatterSchema.safeParse({ ...base, effort });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid effort value', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      effort: 'extreme',
    });
    expect(result.success).toBe(false);
  });

  it('still validates base schema fields', () => {
    const result = CommandFrontmatterSchema.safeParse({
      name: 'INVALID',
      description: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid context value', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      context: 'background',
    });
    expect(result.success).toBe(false);
  });

  it('accepts user-invocable=false to hide from slash menu', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      'user-invocable': false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['user-invocable']).toBe(false);
    }
  });

  it('requires description', () => {
    const result = CommandFrontmatterSchema.safeParse({ name: 'valid-name' });
    expect(result.success).toBe(false);
  });

  it('inherits base schema optional fields (license, compatibility, metadata)', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      license: 'MIT',
      compatibility: 'DorkOS >= 1.0',
      metadata: { team: 'platform' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts model override as arbitrary string', () => {
    const result = CommandFrontmatterSchema.safeParse({
      ...base,
      model: 'claude-opus-4-20250514',
    });
    expect(result.success).toBe(true);
  });
});
