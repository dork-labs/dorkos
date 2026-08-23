import { describe, it, expect } from 'vitest';
import {
  SkillFrontmatterSchema,
  SkillKindSchema,
  SkillNameSchema,
  isUserInvocable,
  isModelInvocable,
  readYamlBoolean,
} from '../schema.js';
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

describe('invocation frontmatter', () => {
  const base = { name: 'deploy', description: 'Ship the app' };

  it('carries user-invocable and disable-model-invocation through a base parse', () => {
    const parsed = SkillFrontmatterSchema.parse({
      ...base,
      'user-invocable': false,
      'disable-model-invocation': true,
    });
    expect(parsed['user-invocable']).toBe(false);
    expect(parsed['disable-model-invocation']).toBe(true);
  });

  it('leaves both fields absent when the author omits them (no materialized default)', () => {
    const parsed = SkillFrontmatterSchema.parse(base);
    expect(parsed['user-invocable']).toBeUndefined();
    expect(parsed['disable-model-invocation']).toBeUndefined();
  });

  // js-yaml v4 is YAML 1.2 core, so gray-matter hands us these as STRINGS.
  // A person writing `user-invocable: no` means false and must not have their
  // whole skill rejected over the dialect.
  it.each([
    ['no', false],
    ['off', false],
    ['n', false],
    ['"false"', false],
    ['False', false],
    ['yes', true],
    ['on', true],
    ['y', true],
    ['True', true],
  ])('reads the YAML 1.1 word %s as %s', (word, expected) => {
    const raw = word.replaceAll('"', '');
    expect(SkillFrontmatterSchema.parse({ ...base, 'user-invocable': raw })['user-invocable']).toBe(
      expected
    );
    expect(
      SkillFrontmatterSchema.parse({ ...base, 'disable-model-invocation': raw })[
        'disable-model-invocation'
      ]
    ).toBe(expected);
  });

  it('ignores surrounding whitespace on a boolean word', () => {
    expect(
      SkillFrontmatterSchema.parse({ ...base, 'user-invocable': '  No  ' })['user-invocable']
    ).toBe(false);
  });

  it('degrades an unreadable value to absent instead of rejecting the skill', () => {
    // Pre-change, an unknown key was simply stripped and the skill parsed
    // fine. A typo here must not delete the whole skill from the product.
    const parsed = SkillFrontmatterSchema.safeParse({
      ...base,
      'user-invocable': 'maybe',
      'disable-model-invocation': 42,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data['user-invocable']).toBeUndefined();
      expect(parsed.data['disable-model-invocation']).toBeUndefined();
    }
  });

  it('treats a garbage value as permissive on both questions', () => {
    const meta = SkillFrontmatterSchema.parse({
      ...base,
      'user-invocable': 'maybe',
      'disable-model-invocation': 'sometimes',
    });
    expect(isUserInvocable(meta)).toBe(true);
    expect(isModelInvocable(meta)).toBe(true);
  });
});

describe('readYamlBoolean', () => {
  it('passes real booleans through', () => {
    expect(readYamlBoolean(true)).toBe(true);
    expect(readYamlBoolean(false)).toBe(false);
  });

  it('reads the YAML 1.1 words', () => {
    expect(readYamlBoolean('no')).toBe(false);
    expect(readYamlBoolean('YES')).toBe(true);
  });

  it('returns undefined for absent or unreadable values', () => {
    expect(readYamlBoolean(undefined)).toBeUndefined();
    expect(readYamlBoolean('maybe')).toBeUndefined();
    expect(readYamlBoolean(0)).toBeUndefined();
  });
});

describe('isUserInvocable', () => {
  it('says yes when the field is absent', () => {
    expect(isUserInvocable({})).toBe(true);
  });

  it('says yes on an explicit true', () => {
    expect(isUserInvocable({ 'user-invocable': true })).toBe(true);
  });

  it('says no only on an explicit false', () => {
    expect(isUserInvocable({ 'user-invocable': false })).toBe(false);
  });
});

describe('isModelInvocable', () => {
  it('says yes when the field is absent', () => {
    expect(isModelInvocable({})).toBe(true);
  });

  it('says yes on an explicit false', () => {
    expect(isModelInvocable({ 'disable-model-invocation': false })).toBe(true);
  });

  it('says no only on an explicit true', () => {
    expect(isModelInvocable({ 'disable-model-invocation': true })).toBe(false);
  });
});
