/**
 * The field-by-field mapping from the legacy top-level shape onto the
 * `schedule:` block.
 *
 * Lived in `packages/skills/src/__tests__/schedule-schema.test.ts` until
 * DOR-1486, and moved here with the function it covers. The move is the point:
 * `legacyTaskToSchedule` is private to the migration now, so its tests belong
 * beside it and are deleted with it at the sunset.
 */
import { describe, it, expect } from 'vitest';
import { ScheduleBlockSchema } from '@dorkos/skills';
import { legacyTaskToSchedule } from '../legacy-migration.js';

/** The legacy defaults, applied the way the migration's own schema applies them. */
function legacy(fields: Record<string, unknown> = {}): Parameters<typeof legacyTaskToSchedule>[0] {
  return {
    timezone: 'UTC',
    enabled: true,
    permissions: 'acceptEdits',
    ...fields,
  } as Parameters<typeof legacyTaskToSchedule>[0];
}

describe('legacyTaskToSchedule', () => {
  it('maps every legacy top-level field into the block', () => {
    expect(
      legacyTaskToSchedule(
        legacy({
          cron: '0 9 * * *',
          timezone: 'America/New_York',
          enabled: false,
          'max-runtime': '30m',
          permissions: 'plan',
          origin: 'shape',
          shape: 'ops-shape',
        })
      )
    ).toEqual({
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      enabled: false,
      sticky: false,
      'max-runtime': '30m',
      permissions: 'plan',
      origin: 'shape',
      shape: 'ops-shape',
    });
  });

  it('carries the legacy defaults through unchanged', () => {
    expect(legacyTaskToSchedule(legacy())).toEqual({
      timezone: 'UTC',
      enabled: true,
      sticky: false,
      permissions: 'acceptEdits',
    });
  });

  it('produces a block the new schema accepts', () => {
    expect(
      ScheduleBlockSchema.safeParse(legacyTaskToSchedule(legacy({ cron: '*/5 * * * *' }))).success
    ).toBe(true);
  });

  it('turns an empty legacy cron into an absent one', () => {
    // The legacy schema accepted `cron: ''`; the block does not, and both mean
    // on-demand. Mapping it through unchanged would fail the rewritten file.
    const block = legacyTaskToSchedule(legacy({ cron: '' }));
    expect(block.cron).toBeUndefined();
    expect(ScheduleBlockSchema.safeParse(block).success).toBe(true);
  });

  it('never invents a prompt — the body still fires', () => {
    expect(legacyTaskToSchedule(legacy({ cron: '0 9 * * *' })).prompt).toBeUndefined();
  });

  it.each([
    ['origin without shape', { origin: 'shape' as const }, { origin: 'shape' }],
    ['shape without origin', { shape: 'orphan-pkg' }, { shape: 'orphan-pkg' }],
  ])('carries %s through as written', (_label, extra, expected) => {
    expect(legacyTaskToSchedule(legacy(extra))).toEqual({
      timezone: 'UTC',
      enabled: true,
      sticky: false,
      permissions: 'acceptEdits',
      ...expected,
    });
  });

  it('leaves prompt and cron identical, which is why an approval survives', () => {
    // The property the whole grant re-keying rests on: an approval is keyed on
    // `(prompt, cron)`, and the migration rewrites neither. Stated as its own
    // assertion because the day someone teaches the mapping to normalize a cron
    // is the day every approved schedule silently re-parks.
    const block = legacyTaskToSchedule(legacy({ cron: '0 9 * * 1-5' }));
    expect(block.cron).toBe('0 9 * * 1-5');
    expect(block.prompt).toBeUndefined();
  });
});
