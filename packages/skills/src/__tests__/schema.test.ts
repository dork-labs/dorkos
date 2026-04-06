import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema, SkillKindSchema, SkillNameSchema } from '../schema.js';
import type { SkillKind } from '../schema.js';

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

  it('accepts frontmatter with kind: "skill"', () => {
    const result = SkillFrontmatterSchema.safeParse({ ...minimal, kind: 'skill' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('skill');
    }
  });

  it('accepts frontmatter with kind: "task"', () => {
    const result = SkillFrontmatterSchema.safeParse({ ...minimal, kind: 'task' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('task');
    }
  });

  it('accepts frontmatter with kind: "command"', () => {
    const result = SkillFrontmatterSchema.safeParse({ ...minimal, kind: 'command' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('command');
    }
  });

  it('rejects frontmatter with kind: "extension" (invalid value)', () => {
    const result = SkillFrontmatterSchema.safeParse({ ...minimal, kind: 'extension' });
    expect(result.success).toBe(false);
  });

  it('preserves backwards compatibility — frontmatter without kind still validates', () => {
    const result = SkillFrontmatterSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBeUndefined();
    }
  });
});

describe('SkillKindSchema', () => {
  it('parses "skill" successfully', () => {
    expect(SkillKindSchema.parse('skill')).toBe('skill');
  });

  it('parses "task" successfully', () => {
    expect(SkillKindSchema.parse('task')).toBe('task');
  });

  it('parses "command" successfully', () => {
    expect(SkillKindSchema.parse('command')).toBe('command');
  });

  it('rejects an unknown kind', () => {
    expect(SkillKindSchema.safeParse('extension').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(SkillKindSchema.safeParse('').success).toBe(false);
  });

  it('SkillKind type alias is assignable from each enum value', () => {
    const skillKind: SkillKind = 'skill';
    const taskKind: SkillKind = 'task';
    const commandKind: SkillKind = 'command';
    expect([skillKind, taskKind, commandKind]).toEqual(['skill', 'task', 'command']);
  });
});
