import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import {
  ScheduleBlockSchema,
  TASK_PERMISSION_MODES,
  hasSchedule,
  scheduleToFrontmatter,
} from '../schedule-schema.js';
import { SkillFrontmatterSchema } from '../schema.js';
import { TaskFrontmatterSchema, legacyTaskToSchedule } from '../task-schema.js';
import { parseSkillFile } from '../parser.js';
import { writeSkillFile } from '../writer.js';
import { SKILL_FILENAME } from '../constants.js';

describe('ScheduleBlockSchema', () => {
  it('accepts every field', () => {
    const result = ScheduleBlockSchema.safeParse({
      cron: '0 9 * * 1-5',
      timezone: 'America/New_York',
      enabled: false,
      'max-runtime': '30m',
      permissions: 'bypassPermissions',
      prompt: 'Check the deploy queue.',
      origin: 'plugin',
      shape: 'flow',
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults (timezone=UTC, enabled=true, permissions=acceptEdits)', () => {
    const block = ScheduleBlockSchema.parse({});
    expect(block.timezone).toBe('UTC');
    expect(block.enabled).toBe(true);
    expect(block.permissions).toBe('acceptEdits');
  });

  it('treats an absent cron as on-demand rather than invalid', () => {
    const block = ScheduleBlockSchema.parse({ prompt: 'Run when asked.' });
    expect(block.cron).toBeUndefined();
  });

  // Dropping a broken cron silently would turn a schedule the author meant to
  // fire into one that never does. Failing here parks the file with a warning
  // instead, which is the outcome the spec asks for.
  it('rejects an empty cron instead of degrading it to absent', () => {
    expect(ScheduleBlockSchema.safeParse({ cron: '' }).success).toBe(false);
    expect(ScheduleBlockSchema.safeParse({ cron: '   ' }).success).toBe(true);
  });

  it('validates cron SHAPE only — semantics belong to the server seam', () => {
    // croner would reject this; the schema deliberately does not know that.
    expect(ScheduleBlockSchema.safeParse({ cron: 'not a cron at all' }).success).toBe(true);
    expect(ScheduleBlockSchema.safeParse({ cron: '99 99 * * *' }).success).toBe(true);
    expect(ScheduleBlockSchema.safeParse({ timezone: 'Mars/Olympus_Mons' }).success).toBe(true);
  });

  it('rejects an empty timezone and an empty prompt', () => {
    expect(ScheduleBlockSchema.safeParse({ timezone: '' }).success).toBe(false);
    expect(ScheduleBlockSchema.safeParse({ prompt: '' }).success).toBe(false);
  });

  it('rejects a malformed max-runtime', () => {
    expect(ScheduleBlockSchema.safeParse({ 'max-runtime': '30 minutes' }).success).toBe(false);
    expect(ScheduleBlockSchema.parse({ 'max-runtime': '2h30m' })['max-runtime']).toBe('2h30m');
  });

  it('rejects a permission mode outside the allowed set', () => {
    expect(ScheduleBlockSchema.safeParse({ permissions: 'yolo' }).success).toBe(false);
  });

  it('accepts both provenance origins', () => {
    expect(ScheduleBlockSchema.parse({ origin: 'shape' }).origin).toBe('shape');
    expect(ScheduleBlockSchema.parse({ origin: 'plugin' }).origin).toBe('plugin');
    expect(ScheduleBlockSchema.safeParse({ origin: 'somewhere' }).success).toBe(false);
  });

  // The falsy rows are the ones that discriminate: `enabled` falls back to
  // true, so a truthy row would still pass against a schema that had lost its
  // coercion and simply thrown the word away. Both are kept — the truthy rows
  // pin that a recognized word never fails the parse — but do not read them as
  // evidence that coercion works.
  it.each([
    ['no', false],
    ['off', false],
    ['"false"', false],
    ['yes', true],
    ['on', true],
    ['True', true],
  ])('reads the YAML 1.1 word %s in enabled as %s', (word, expected) => {
    const raw = word.replaceAll('"', '');
    expect(ScheduleBlockSchema.parse({ enabled: raw }).enabled).toBe(expected);
  });

  it('falls back to enabled when the value is unreadable', () => {
    expect(ScheduleBlockSchema.parse({ enabled: 'maybe' }).enabled).toBe(true);
  });
});

describe('TASK_PERMISSION_MODES', () => {
  // The v3/v4 zod boundary means the two lists are inlined copies, not one
  // composed schema. Read the options as strings so the versions never meet.
  it('matches the session permission modes in @dorkos/shared', () => {
    expect([...TASK_PERMISSION_MODES].sort()).toEqual([...PermissionModeSchema.options].sort());
  });
});

describe('hasSchedule', () => {
  const base = { name: 'daily-check', description: 'Runs a daily health check' };

  it('says no for a plain skill', () => {
    expect(hasSchedule(SkillFrontmatterSchema.parse(base))).toBe(false);
  });

  it('says yes as soon as the block is present, cron or not', () => {
    expect(hasSchedule(SkillFrontmatterSchema.parse({ ...base, schedule: {} }))).toBe(true);
    expect(
      hasSchedule(SkillFrontmatterSchema.parse({ ...base, schedule: { cron: '0 9 * * *' } }))
    ).toBe(true);
  });

  it('narrows the schedule to present', () => {
    const meta = SkillFrontmatterSchema.parse({ ...base, schedule: { cron: '0 9 * * *' } });
    if (hasSchedule(meta)) {
      // Compiles only because the guard narrowed `schedule` away from undefined.
      expect(meta.schedule.cron).toBe('0 9 * * *');
    } else {
      throw new Error('guard should have narrowed');
    }
  });
});

describe('scheduleToFrontmatter', () => {
  it('writes back only what the author would have typed', () => {
    const block = ScheduleBlockSchema.parse({ cron: '0 9 * * *' });
    expect(scheduleToFrontmatter(block)).toEqual({ cron: '0 9 * * *' });
  });

  it('keeps a non-default value even when it looks like an absence', () => {
    const block = ScheduleBlockSchema.parse({ cron: '0 9 * * *', enabled: false });
    expect(scheduleToFrontmatter(block)).toEqual({ cron: '0 9 * * *', enabled: false });
  });

  it('keeps every non-default field', () => {
    const block = ScheduleBlockSchema.parse({
      cron: '0 9 * * *',
      timezone: 'Europe/Berlin',
      'max-runtime': '15m',
      permissions: 'plan',
      prompt: 'Do the thing.',
      origin: 'shape',
      shape: 'my-shape',
    });
    expect(scheduleToFrontmatter(block)).toEqual({
      cron: '0 9 * * *',
      timezone: 'Europe/Berlin',
      'max-runtime': '15m',
      permissions: 'plan',
      prompt: 'Do the thing.',
      origin: 'shape',
      shape: 'my-shape',
    });
  });

  // `schedule: {}` reads back as `schedule: null`, which is not a schedule at
  // all — so an all-default on-demand block reports "nothing to write" and the
  // caller drops the key.
  it('returns undefined when nothing but defaults is left', () => {
    expect(scheduleToFrontmatter(ScheduleBlockSchema.parse({}))).toBeUndefined();
  });
});

describe('legacyTaskToSchedule', () => {
  const base = { name: 'daily-check', description: 'Runs a daily health check' };

  it('maps every legacy top-level field into the block', () => {
    const meta = TaskFrontmatterSchema.parse({
      ...base,
      'display-name': 'Daily Health Check',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      enabled: false,
      'max-runtime': '30m',
      permissions: 'plan',
      origin: 'shape',
      shape: 'ops-shape',
    });

    expect(legacyTaskToSchedule(meta)).toEqual({
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      enabled: false,
      'max-runtime': '30m',
      permissions: 'plan',
      origin: 'shape',
      shape: 'ops-shape',
    });
  });

  it('carries the legacy defaults through unchanged', () => {
    expect(legacyTaskToSchedule(TaskFrontmatterSchema.parse(base))).toEqual({
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    });
  });

  it('produces a block the new schema accepts', () => {
    const meta = TaskFrontmatterSchema.parse({ ...base, cron: '*/5 * * * *' });
    expect(ScheduleBlockSchema.safeParse(legacyTaskToSchedule(meta)).success).toBe(true);
  });

  it('turns an empty legacy cron into an absent one', () => {
    // The legacy schema accepted `cron: ''`; the block does not, and both mean
    // on-demand. Mapping it through unchanged would fail the rewritten file.
    const meta = TaskFrontmatterSchema.parse({ ...base, cron: '' });
    expect(meta.cron).toBe('');
    const block = legacyTaskToSchedule(meta);
    expect(block.cron).toBeUndefined();
    expect(ScheduleBlockSchema.safeParse(block).success).toBe(true);
  });

  it('leaves display-name behind — it belongs to the skill, not the schedule', () => {
    const meta = TaskFrontmatterSchema.parse({ ...base, 'display-name': 'Daily Health Check' });
    expect(legacyTaskToSchedule(meta)).not.toHaveProperty('display-name');
  });

  it('never invents a prompt — the body still fires', () => {
    const meta = TaskFrontmatterSchema.parse({ ...base, cron: '0 9 * * *' });
    expect(legacyTaskToSchedule(meta).prompt).toBeUndefined();
  });

  it.each([
    ['origin without shape', { origin: 'shape' as const }, { origin: 'shape' }],
    ['shape without origin', { shape: 'orphan-pkg' }, { shape: 'orphan-pkg' }],
  ])('carries %s through as written', (_label, extra, expected) => {
    const block = legacyTaskToSchedule(TaskFrontmatterSchema.parse({ ...base, ...extra }));
    expect(block).toEqual({
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
      ...expected,
    });
  });
});

describe('schedule block round trip through disk', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-schedule-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const read = (name: string) => fs.readFile(path.join(tmpDir, name, SKILL_FILENAME), 'utf-8');

  const parse = async (name: string) => {
    const filePath = path.join(tmpDir, name, SKILL_FILENAME);
    const result = parseSkillFile(filePath, await read(name), SkillFrontmatterSchema);
    if (!result.ok) throw new Error(result.error);
    return result.definition;
  };

  it('survives the writer and comes back whole', async () => {
    await writeSkillFile(
      tmpDir,
      'daily-check',
      {
        name: 'daily-check',
        description: 'Runs a daily health check',
        schedule: {
          cron: '0 9 * * 1-5',
          timezone: 'Europe/Berlin',
          enabled: false,
          'max-runtime': '45m',
          permissions: 'plan',
          prompt: 'Check every service.',
          origin: 'plugin',
          shape: 'ops-plugin',
        },
      },
      'Check every service and report.'
    );

    // The writer must nest the block, not flatten it into dotted keys.
    expect(await read('daily-check')).toContain('schedule:');

    const definition = await parse('daily-check');
    expect(hasSchedule(definition.meta)).toBe(true);
    expect(definition.meta.schedule).toEqual({
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
      enabled: false,
      'max-runtime': '45m',
      permissions: 'plan',
      prompt: 'Check every service.',
      origin: 'plugin',
      shape: 'ops-plugin',
    });
    expect(definition.body).toBe('Check every service and report.');
  });

  it('reads a hand-written nested block', async () => {
    const content = [
      '---',
      'name: daily-check',
      'description: Runs a daily health check',
      'schedule:',
      "  cron: '0 9 * * 1-5'",
      '  enabled: no',
      '---',
      '',
      'Check every service.',
    ].join('\n');

    const result = parseSkillFile('/skills/daily-check/SKILL.md', content, SkillFrontmatterSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.meta.schedule).toEqual({
      cron: '0 9 * * 1-5',
      timezone: 'UTC',
      enabled: false,
      permissions: 'acceptEdits',
    });
  });

  // The known wart, pinned in both directions: defaults are materialized on
  // parse, so a caller that writes the parsed frontmatter straight back grows
  // lines the author never typed. It must never grow a `schedule:` block out of
  // nothing, and `scheduleToFrontmatter` is the way to write one back minimally.
  it('does not grow a schedule block on a skill that has none', async () => {
    await writeSkillFile(
      tmpDir,
      'plain-skill',
      { name: 'plain-skill', description: 'Just a skill' },
      'Body.'
    );
    const definition = await parse('plain-skill');
    await writeSkillFile(tmpDir, 'plain-skill', { ...definition.meta }, definition.body);

    const content = await read('plain-skill');
    expect(content).not.toContain('schedule');
    expect(content).not.toContain('timezone');
    expect(content).not.toContain('permissions');
  });

  it('DOES grow the schedule siblings when the parsed block is written back raw', async () => {
    await writeSkillFile(
      tmpDir,
      'cron-only',
      {
        name: 'cron-only',
        description: 'Runs a daily health check',
        schedule: { cron: '0 9 * * *' },
      },
      'Body.'
    );
    expect(await read('cron-only')).not.toContain('timezone');

    const definition = await parse('cron-only');
    await writeSkillFile(tmpDir, 'cron-only', { ...definition.meta }, definition.body);

    const content = await read('cron-only');
    expect(content).toContain('timezone: UTC');
    expect(content).toContain('enabled: true');
    expect(content).toContain('permissions: acceptEdits');
  });

  it('stays minimal when the parsed block is written back through scheduleToFrontmatter', async () => {
    await writeSkillFile(
      tmpDir,
      'cron-only',
      {
        name: 'cron-only',
        description: 'Runs a daily health check',
        schedule: { cron: '0 9 * * *' },
      },
      'Body.'
    );

    const first = await parse('cron-only');
    if (!hasSchedule(first.meta)) throw new Error('expected a schedule');
    await writeSkillFile(
      tmpDir,
      'cron-only',
      { ...first.meta, schedule: scheduleToFrontmatter(first.meta.schedule) },
      first.body
    );

    const content = await read('cron-only');
    expect(content).not.toContain('timezone');
    expect(content).not.toContain('enabled');
    expect(content).not.toContain('permissions');

    // And the meaning is unchanged: the defaults come back on the next read.
    const second = await parse('cron-only');
    expect(second.meta.schedule).toEqual(first.meta.schedule);
  });
});
