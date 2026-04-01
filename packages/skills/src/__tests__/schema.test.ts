import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema, SkillNameSchema } from '../schema.js';

describe('SkillNameSchema', () => {
  it('accepts a valid kebab-case name', () => {
    expect(SkillNameSchema.safeParse('daily-health-check').success).toBe(true);
  });

  it('accepts a single character', () => {
    expect(SkillNameSchema.safeParse('a').success).toBe(true);
  });

  it('accepts a single digit', () => {
    expect(SkillNameSchema.safeParse('1').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(SkillNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name longer than 64 characters', () => {
    expect(SkillNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rejects uppercase characters', () => {
    expect(SkillNameSchema.safeParse('Daily-Check').success).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    expect(SkillNameSchema.safeParse('-daily-check').success).toBe(false);
  });

  it('rejects name ending with hyphen', () => {
    expect(SkillNameSchema.safeParse('daily-check-').success).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(SkillNameSchema.safeParse('daily--check').success).toBe(false);
  });

  it('rejects special characters', () => {
    expect(SkillNameSchema.safeParse('daily_check').success).toBe(false);
    expect(SkillNameSchema.safeParse('daily.check').success).toBe(false);
    expect(SkillNameSchema.safeParse('daily check').success).toBe(false);
  });
});

describe('SkillFrontmatterSchema', () => {
  const minimal = { name: 'my-skill', description: 'Does something useful' };

  it('accepts minimal valid frontmatter (name + description)', () => {
    const result = SkillFrontmatterSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('accepts all optional fields', () => {
    const full = {
      ...minimal,
      license: 'MIT',
      compatibility: 'Requires Node.js 20+',
      metadata: { category: 'devops', author: 'kai' },
      'allowed-tools': 'Read Edit Bash',
    };
    const result = SkillFrontmatterSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = SkillFrontmatterSchema.safeParse({ description: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = SkillFrontmatterSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects name with uppercase', () => {
    const result = SkillFrontmatterSchema.safeParse({ name: 'My-Skill', description: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects description longer than 1024 characters', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'test',
      description: 'a'.repeat(1025),
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid metadata map', () => {
    const result = SkillFrontmatterSchema.safeParse({
      ...minimal,
      metadata: { key: 'value', another: 'entry' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-string metadata values', () => {
    const result = SkillFrontmatterSchema.safeParse({
      ...minimal,
      metadata: { key: 123 },
    });
    expect(result.success).toBe(false);
  });
});
