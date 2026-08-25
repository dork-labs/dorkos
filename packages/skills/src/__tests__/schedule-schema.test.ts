import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import {
  ScheduleBlockSchema,
  TASK_PERMISSION_MODES,
  hasSchedule,
  isInvalidSchedule,
  readScheduleField,
  scheduleProblem,
  scheduleToFrontmatter,
} from '../schedule-schema.js';
import { SkillFrontmatterSchema } from '../schema.js';
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

  // The BLOCK rejects an empty cron, so a broken schedule is never silently
  // rewritten into one that simply never fires. What the surrounding FILE does
  // with that rejection is a separate decision, pinned below under "a bad
  // schedule block never costs the skill": the file survives as a skill, and
  // the rejection travels with it as an InvalidSchedule for discovery to park.
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

  // Because that fallback is ON, a value we misread arms a schedule the author
  // was trying to switch off. `enabled: 0` is the one an author actually types.
  it('reads a numeric 0/1 rather than falling back to armed', () => {
    expect(ScheduleBlockSchema.parse({ enabled: 0 }).enabled).toBe(false);
    expect(ScheduleBlockSchema.parse({ enabled: 1 }).enabled).toBe(true);
    expect(ScheduleBlockSchema.parse({ enabled: '0' }).enabled).toBe(false);
  });
});

describe('TASK_PERMISSION_MODES', () => {
  // `TASK_PERMISSION_MODES` is an inlined copy rather than the imported schema,
  // so that shipping `schedule-schema.ts` to the browser does not drag all of
  // `@dorkos/shared/schemas` along for six strings (see its DRIFT NOTE). This is
  // the assertion that keeps the copy honest, and importing the source HERE
  // costs the bundle nothing — a test is never bundled.
  //
  // This is now the ONLY copy of this assertion. `task-schema.test.ts` carried a
  // duplicate of it while `@dorkos/marketplace` imported the modes through the
  // legacy re-export; both the re-export and the duplicate went with
  // `task-schema.ts` in DOR-1486.
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

  // The distinction this pair exists to draw. Both answer `false` to "is this a
  // scheduled task", and they are not the same thing at all: one file has no
  // schedule, the other has one nobody can read. Only the second gets a row.
  it('says no for an unreadable block, but keeps the complaint', () => {
    const meta = SkillFrontmatterSchema.parse({ ...base, schedule: { cron: '' } });
    expect(hasSchedule(meta)).toBe(false);
    expect(scheduleProblem(meta)).toMatch(/"cron"/);
  });

  it('has nothing to complain about when there is no block at all', () => {
    expect(scheduleProblem(SkillFrontmatterSchema.parse(base))).toBeNull();
  });

  it('has nothing to complain about when the block is fine', () => {
    expect(
      scheduleProblem(SkillFrontmatterSchema.parse({ ...base, schedule: { cron: '0 9 * * *' } }))
    ).toBeNull();
  });
});

describe('readScheduleField', () => {
  it('answers absent for a missing key', () => {
    expect(readScheduleField(undefined)).toBeUndefined();
    expect(readScheduleField(null)).toBeUndefined();
  });

  it('answers a block for a readable one', () => {
    const field = readScheduleField({ cron: '0 9 * * *' });
    expect(isInvalidSchedule(field)).toBe(false);
    expect(field).toMatchObject({ cron: '0 9 * * *', timezone: 'UTC', enabled: true });
  });

  it.each([
    ['an empty cron', { cron: '' }, /"cron"/],
    ['a permission mode nobody has', { permissions: 'yolo' }, /"permissions"/],
    ['a max-runtime in words', { 'max-runtime': '30 minutes' }, /"max-runtime"/],
    ['a scalar where a mapping belongs', 'daily', /schedule/],
  ])('answers a complaint naming %s', (_label, raw, expected) => {
    const field = readScheduleField(raw);
    if (!isInvalidSchedule(field)) throw new Error('expected a complaint');
    expect(field.problem).toMatch(expected);
    // The complaint is a sentence for a person, not a zod dump.
    expect(field.problem.endsWith('.')).toBe(true);
  });

  it('never throws, whatever the file put there', () => {
    for (const raw of [42, [], true, { cron: { nested: 'mapping' } }]) {
      expect(() => readScheduleField(raw)).not.toThrow();
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

  // An all-default block still has to WRITE something: presence of the key is
  // what makes the file a scheduled task, so an empty mapping keeps the skill
  // scheduled where dropping the key would silently un-schedule it.
  it('returns an empty mapping when nothing but defaults is left', () => {
    expect(scheduleToFrontmatter(ScheduleBlockSchema.parse({}))).toEqual({});
  });

  it('drops a hand-typed enabled: true, which the file cannot tell from a default', () => {
    const block = ScheduleBlockSchema.parse({ cron: '0 9 * * *', enabled: true });
    expect(scheduleToFrontmatter(block)).toEqual({ cron: '0 9 * * *' });
  });
});

// `legacyTaskToSchedule` used to live beside these helpers. It moved into
// `apps/server/src/services/tasks/legacy-migration.ts` with the rest of the
// legacy shape, and its tests moved with it — see
// `legacy-migration-mapping.test.ts` there.
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

  // Old-vs-new pins. Every value below was simply STRIPPED as an unknown key
  // before the schemas unified, so the skill parsed. Introducing the fields
  // must not turn a file that worked into one that fails: a failed parse is
  // not a stern warning, it is the skill disappearing from the model's
  // listing, from the Codex slash palette, and taking a marketplace pack
  // install down with it.
  it.each([
    ['a shell DorkOS does not run', 'shell: zsh'],
    ['a Codex effort this enum omits', 'effort: xhigh'],
    ['a schedule that is not a mapping', 'schedule: daily'],
    ['a malformed schedule block', 'schedule:\n  cron: ""'],
  ])('still parses as a skill with %s', async (_label, frontmatterLine) => {
    const content = [
      '---',
      'name: survivor',
      'description: Must not vanish over one line',
      frontmatterLine,
      '---',
      '',
      'Body.',
    ].join('\n');

    const result = parseSkillFile('/skills/survivor/SKILL.md', content, SkillFrontmatterSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.meta.name).toBe('survivor');
  });

  it('a bad schedule block never costs the skill — it parks instead of vanishing', () => {
    const content = [
      '---',
      'name: survivor',
      'description: Must not vanish over one line',
      'schedule:',
      "  cron: ''",
      '---',
      '',
      'Body.',
    ].join('\n');

    const result = parseSkillFile('/skills/survivor/SKILL.md', content, SkillFrontmatterSchema);
    // The whole point: the FILE survives, so the skill keeps its place in the
    // model's listing, the Codex palette and its marketplace pack.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.meta.description).toBe('Must not vanish over one line');
    // There is no schedule to run...
    expect(hasSchedule(result.definition.meta)).toBe(false);
    // ...and, unlike before DOR-1485, the reason is not thrown away. This is
    // what discovery parks a row with.
    expect(scheduleProblem(result.definition.meta)).toMatch(/"cron"/);
  });

  it('a skill with no schedule block at all stays silent, not parked', () => {
    const content = ['---', 'name: plain', 'description: Just a skill', '---', '', 'Body.'].join(
      '\n'
    );

    const result = parseSkillFile('/skills/plain/SKILL.md', content, SkillFrontmatterSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hasSchedule(result.definition.meta)).toBe(false);
    expect(scheduleProblem(result.definition.meta)).toBeNull();
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

  it('writes an all-default block as an empty mapping that stays a schedule', async () => {
    const block = ScheduleBlockSchema.parse({});
    await writeSkillFile(
      tmpDir,
      'on-demand',
      {
        name: 'on-demand',
        description: 'Runs only when asked',
        schedule: scheduleToFrontmatter(block),
      },
      'Body.'
    );

    // The key survives the write, so the file is still a scheduled task.
    expect(await read('on-demand')).toContain('schedule: {}');
    const definition = await parse('on-demand');
    expect(hasSchedule(definition.meta)).toBe(true);
    expect(definition.meta.schedule).toEqual({
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    });
  });

  // The documented call shape must survive the all-default case. Returning
  // `undefined` here would hand js-yaml an undefined and throw
  // "unacceptable kind of an object" at the moment of writing.
  it('does not throw when the helper result is spread into frontmatter', async () => {
    await writeSkillFile(
      tmpDir,
      'spread-check',
      { name: 'spread-check', description: 'Runs only when asked', schedule: {} },
      'Body.'
    );
    const first = await parse('spread-check');
    if (!hasSchedule(first.meta)) throw new Error('expected a schedule');

    await expect(
      writeSkillFile(
        tmpDir,
        'spread-check',
        { ...first.meta, schedule: scheduleToFrontmatter(first.meta.schedule) },
        first.body
      )
    ).resolves.toBeTruthy();

    expect(hasSchedule((await parse('spread-check')).meta)).toBe(true);
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
