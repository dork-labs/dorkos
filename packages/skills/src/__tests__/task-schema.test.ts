import { describe, it, expect } from 'vitest';
import {
  PermissionModeSchema,
  CreateTaskRequestSchema,
  TASK_DURATION_PATTERN,
  TASK_DESCRIPTION_MAX,
} from '@dorkos/shared/schemas';
import { TaskFrontmatterSchema, TASK_PERMISSION_MODES } from '../task-schema.js';
import { DurationSchema } from '../duration.js';
import { slugify, validateSlug } from '../slug.js';

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

describe('request-vs-frontmatter drift — the fields POST /api/tasks writes into a SKILL.md', () => {
  // `CreateTaskRequestSchema` accepts a body, the route writes it into a SKILL.md
  // and reads it straight back with `TaskFrontmatterSchema`. A field the request
  // accepts and the frontmatter rejects is not a cosmetic mismatch: whether that
  // re-parse succeeds used to decide which create path ran, and only one of them
  // clamped the permission mode. An agent forbidden from naming `permissionMode`
  // could therefore land a `bypassPermissions` schedule by sending
  // `maxRuntime: 'banana'` (DOR-1432 stage-2 review).
  //
  // Both paths clamp now, so this is the second layer. It lives HERE, in the
  // package that owns the frontmatter, because shared cannot import this one —
  // skills depends on shared, and the two are on different major zod versions.
  // Derived from both sides rather than restating today's values, so it still
  // fires the day either side moves.

  it('the duration mirror in shared matches this package DurationSchema', () => {
    const cases = ['5m', '1h', '30s', '2h30m', '', 'banana', '30', '1d', '5 m'];
    for (const value of cases) {
      expect(
        { value, accepted: TASK_DURATION_PATTERN.test(value) && value.length > 0 },
        `duration mirror disagrees on ${JSON.stringify(value)}`
      ).toEqual({ value, accepted: DurationSchema.safeParse(value).success });
    }
  });

  it('the description cap in shared matches this package frontmatter', () => {
    const atCap = 'x'.repeat(TASK_DESCRIPTION_MAX);
    const overCap = 'x'.repeat(TASK_DESCRIPTION_MAX + 1);
    expect(
      TaskFrontmatterSchema.safeParse({ name: 'a', description: atCap }).success,
      'the mirrored cap must be a length the frontmatter still accepts'
    ).toBe(true);
    expect(
      TaskFrontmatterSchema.safeParse({ name: 'a', description: overCap }).success,
      'one over the mirrored cap must be a length the frontmatter rejects'
    ).toBe(false);
  });

  it('a request the schema accepts produces frontmatter this schema accepts', () => {
    // The end-to-end statement of the invariant, over the fields the route
    // actually writes. A body at every boundary the request allows must still
    // parse back, or the route can be steered onto the fallback path.
    const request = CreateTaskRequestSchema.parse({
      name: 'nightly',
      description: 'x'.repeat(TASK_DESCRIPTION_MAX),
      prompt: 'go',
      target: 'global',
      cron: '0 3 * * *',
      timezone: 'UTC',
      maxRuntime: '2h30m',
    });

    const result = TaskFrontmatterSchema.safeParse({
      name: request.name,
      description: request.description,
      cron: request.cron,
      timezone: request.timezone,
      enabled: request.enabled,
      'max-runtime': request.maxRuntime,
    });
    expect(result.success).toBe(true);
  });

  it('refuses the three bodies that used to force the unclamped path', () => {
    const base = { name: 'nightly', description: 'sweep', prompt: 'go', target: 'global' };
    expect(CreateTaskRequestSchema.safeParse({ ...base, maxRuntime: 'banana' }).success).toBe(
      false
    );
    expect(CreateTaskRequestSchema.safeParse({ ...base, maxRuntime: '' }).success).toBe(false);
    expect(
      CreateTaskRequestSchema.safeParse({
        ...base,
        description: 'x'.repeat(TASK_DESCRIPTION_MAX + 1),
      }).success
    ).toBe(false);
    // The third lever, `name: '!!!'`, is a constraint on the DERIVED slug rather
    // than on the body, so the route answers it — see
    // `routes/__tests__/tasks-permission-escalation.test.ts`.
    expect(validateSlug(slugify('!!!'))).toBe(false);
  });
});
