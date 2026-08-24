import { describe, it, expect } from 'vitest';
import { CommandFrontmatterSchema } from '../command-schema.js';
import { SkillFrontmatterSchema, isUserInvocable } from '../schema.js';

describe('CommandFrontmatterSchema', () => {
  const base = { name: 'deploy', description: 'Deploy to production' };

  it('is the base skill schema — a command IS a skill', () => {
    expect(CommandFrontmatterSchema).toBe(SkillFrontmatterSchema);
  });

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

  // The merge dropped this schema's `user-invocable: true` default. Absence is
  // now carried through to `isUserInvocable`, which reads it as yes — so the
  // answer a palette gets is unchanged, and a parse-then-write round trip no
  // longer stamps a line the author never typed into the file.
  it('leaves an absent user-invocable absent, and still reads as visible', () => {
    const result = CommandFrontmatterSchema.parse(base);
    expect(result['user-invocable']).toBeUndefined();
    expect(isUserInvocable(result)).toBe(true);
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

  it('reads YAML 1.1 boolean words the same way the base schema does', () => {
    expect(
      CommandFrontmatterSchema.parse({ ...base, 'user-invocable': 'no' })['user-invocable']
    ).toBe(false);
    expect(
      CommandFrontmatterSchema.parse({ ...base, 'user-invocable': 'yes' })['user-invocable']
    ).toBe(true);
  });

  it('falls back to visible when the value is unreadable', () => {
    const parsed = CommandFrontmatterSchema.safeParse({ ...base, 'user-invocable': 'maybe' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data['user-invocable']).toBeUndefined();
      expect(isUserInvocable(parsed.data)).toBe(true);
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
