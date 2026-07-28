import { describe, it, expect } from 'vitest';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import { TaskFrontmatterSchema, TASK_PERMISSION_MODES } from '../task-schema.js';

describe('TaskFrontmatterSchema', () => {
  const base = { name: 'daily-check', description: 'Runs daily health check' };

  it('accepts all base fields plus task-specific fields', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      'display-name': 'Daily Health Check',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      enabled: true,
      'max-runtime': '30m',
      permissions: 'bypassPermissions',
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults (timezone=UTC, enabled=true, permissions=acceptEdits)', () => {
    const result = TaskFrontmatterSchema.parse(base);
    expect(result.timezone).toBe('UTC');
    expect(result.enabled).toBe(true);
    expect(result.permissions).toBe('acceptEdits');
  });

  it('accepts display-name field', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      'display-name': 'My Custom Name',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid cron expression', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      cron: '*/15 * * * *',
    });
    expect(result.success).toBe(true);
  });

  it('accepts max-runtime duration string', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      'max-runtime': '2h30m',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid permissions value', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      permissions: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('still validates base schema fields', () => {
    const result = TaskFrontmatterSchema.safeParse({
      name: 'INVALID',
      description: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('does not include agentId, cwd, or tags fields', () => {
    const result = TaskFrontmatterSchema.parse(base);
    expect('agentId' in result).toBe(false);
    expect('cwd' in result).toBe(false);
    expect('tags' in result).toBe(false);
  });

  it('rejects invalid max-runtime duration string', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      'max-runtime': 'notaduration',
    });
    expect(result.success).toBe(false);
  });

  it('accepts every permissions enum value', () => {
    for (const permissions of TASK_PERMISSION_MODES) {
      const result = TaskFrontmatterSchema.safeParse({ ...base, permissions });
      expect(result.success, `${permissions} should parse`).toBe(true);
    }
  });

  it('accepts enabled=false to disable scheduling', () => {
    const result = TaskFrontmatterSchema.safeParse({ ...base, enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('requires description', () => {
    const result = TaskFrontmatterSchema.safeParse({ name: 'valid-name' });
    expect(result.success).toBe(false);
  });

  it('inherits base schema optional fields (license, compatibility, metadata)', () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...base,
      license: 'MIT',
      compatibility: 'DorkOS >= 1.0',
      metadata: { owner: 'kai' },
    });
    expect(result.success).toBe(true);
  });
});

describe('PermissionMode drift — task frontmatter mirror vs @dorkos/shared source', () => {
  // `TASK_PERMISSION_MODES` is an inlined mirror of @dorkos/shared's
  // `PermissionModeSchema` (the zod v3/v4 boundary forbids composing the schema
  // itself). Derive both sides here rather than restating today's members: a
  // hardcoded list would still be green the day someone adds a seventh mode to
  // shared, which is exactly the drift that let a Shape declare a mode a task
  // file could not hold.
  it('the two value sets are equal', () => {
    expect([...TASK_PERMISSION_MODES].sort()).toEqual([...PermissionModeSchema.options].sort());
  });

  it('the frontmatter enum accepts exactly those modes and nothing else', () => {
    const field = TaskFrontmatterSchema.shape.permissions.removeDefault();
    expect([...field.options].sort()).toEqual([...PermissionModeSchema.options].sort());
  });
});
