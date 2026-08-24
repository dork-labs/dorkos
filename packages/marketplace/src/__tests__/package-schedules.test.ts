import { describe, it, expect } from 'vitest';
import { MarketplacePackageManifestSchema, SCHEDULE_PERMISSION_MODES } from '../manifest-schema.js';

/** A minimal valid manifest of a given type, with whatever else it needs to parse. */
function manifestOf(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    name: 'nightly-tidy',
    version: '1.0.0',
    type,
    description: 'Keeps the project tidy overnight.',
  };
  if (type === 'adapter') base.adapterType = 'slack';
  return { ...base, ...extra };
}

/** An inline schedule declaration — the form that generates a new skill file. */
function inlineSchedule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'nightly-tidy',
    description: 'Tidy the working tree and report what changed.',
    prompt: 'Look over the working tree and tidy anything obviously stale.',
    cron: '0 3 * * *',
    ...extra,
  };
}

/** Parse and return the parsed schedules, failing loudly if the manifest did not parse. */
function parseSchedules(manifest: Record<string, unknown>): Record<string, unknown>[] {
  const result = MarketplacePackageManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new Error(`expected manifest to parse: ${JSON.stringify(result.error.issues)}`);
  }
  return (result.data as unknown as { schedules: Record<string, unknown>[] }).schedules;
}

/** Every issue path in a failed parse, joined with dots. */
function issuePaths(manifest: Record<string, unknown>): string[] {
  const result = MarketplacePackageManifestSchema.safeParse(manifest);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

// The four types that can carry recurring work. A Shape is covered here for the
// slot itself; its agentRef-specific rules live in shape-manifest.test.ts.
const SCHEDULABLE_TYPES = ['plugin', 'agent', 'skill-pack'] as const;

describe('the shared schedules slot', () => {
  it.each(SCHEDULABLE_TYPES)('accepts an inline schedule on a %s manifest', (type) => {
    const schedules = parseSchedules(manifestOf(type, { schedules: [inlineSchedule()] }));
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.name).toBe('nightly-tidy');
    expect(schedules[0]?.cron).toBe('0 3 * * *');
  });

  it.each(SCHEDULABLE_TYPES)('accepts a skillRef schedule on a %s manifest', (type) => {
    const schedules = parseSchedules(
      manifestOf(type, { schedules: [{ skillRef: 'nightly-tidy', cron: '0 3 * * *' }] })
    );
    expect(schedules[0]?.skillRef).toBe('nightly-tidy');
    // A by-reference entry carries no copy of the skill's own words.
    expect(schedules[0]?.description).toBeUndefined();
    expect(schedules[0]?.prompt).toBeUndefined();
  });

  it.each(SCHEDULABLE_TYPES)('defaults the slot to empty on a %s manifest', (type) => {
    expect(parseSchedules(manifestOf(type))).toEqual([]);
  });

  it('accepts a schedule on a shape manifest (via the shape-specific extension)', () => {
    const schedules = parseSchedules(
      manifestOf('shape', {
        agents: [{ ref: 'tidier', affinity: 'default', matchName: 'Tidier' }],
        schedules: [inlineSchedule({ agentRef: 'tidier' })],
      })
    );
    expect(schedules[0]?.agentRef).toBe('tidier');
  });
});

describe('the adapter refusal', () => {
  it('rejects a schedules slot on an adapter manifest rather than stripping it', () => {
    expect(issuePaths(manifestOf('adapter', { schedules: [inlineSchedule()] }))).toContain(
      'schedules'
    );
  });

  it('names the reason and the remedy in the message', () => {
    const result = MarketplacePackageManifestSchema.safeParse(
      manifestOf('adapter', { schedules: [inlineSchedule()] })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.find((i) => i.path.join('.') === 'schedules')?.message;
    expect(message).toMatch(/Adapters cannot declare schedules/);
    expect(message).toMatch(/plugin that requires this adapter/);
  });

  it('still parses an adapter that declares no schedules', () => {
    const result = MarketplacePackageManifestSchema.safeParse(manifestOf('adapter'));
    expect(result.success).toBe(true);
  });
});

describe('declaration form rules', () => {
  it('rejects an inline entry missing name, description, or prompt', () => {
    for (const field of ['name', 'description', 'prompt'] as const) {
      const schedule = inlineSchedule();
      delete schedule[field];
      expect(issuePaths(manifestOf('plugin', { schedules: [schedule] }))).toContain(
        `schedules.0.${field}`
      );
    }
  });

  it('rejects an entry that declares neither skillRef nor any inline field', () => {
    const paths = issuePaths(manifestOf('plugin', { schedules: [{ cron: '0 3 * * *' }] }));
    expect(paths).toEqual(
      expect.arrayContaining(['schedules.0.name', 'schedules.0.description', 'schedules.0.prompt'])
    );
  });

  it('rejects a skillRef entry that also carries description or prompt', () => {
    for (const field of ['description', 'prompt'] as const) {
      const paths = issuePaths(
        manifestOf('plugin', { schedules: [{ skillRef: 'tidy', [field]: 'duplicated' }] })
      );
      expect(paths).toContain(`schedules.0.${field}`);
    }
  });

  it('reports the offending entry by index when it has no name to report', () => {
    const result = MarketplacePackageManifestSchema.safeParse(
      manifestOf('plugin', { schedules: [{ cron: '0 3 * * *' }] })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes("'#1'"))).toBe(true);
  });

  it('refuses skillRef on a shape and says where the schedule belongs instead', () => {
    const manifest = manifestOf('shape', {
      agents: [{ ref: 'tidier', affinity: 'default', matchName: 'Tidier' }],
      schedules: [inlineSchedule({ agentRef: 'tidier', skillRef: 'nightly-tidy' })],
    });
    const result = MarketplacePackageManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join('.') === 'schedules.0.skillRef');
    expect(issue?.message).toMatch(/plugin or skill-pack/);
  });
});

describe('defaults and safe answers', () => {
  it('starts a schedule disabled when the manifest does not ask otherwise', () => {
    const schedules = parseSchedules(manifestOf('plugin', { schedules: [inlineSchedule()] }));
    expect(schedules[0]?.startEnabled).toBe(false);
  });

  it('carries a startEnabled: true through as the declared intent', () => {
    const schedules = parseSchedules(
      manifestOf('plugin', { schedules: [inlineSchedule({ startEnabled: true })] })
    );
    expect(schedules[0]?.startEnabled).toBe(true);
  });

  it('defaults an absent cron to null (manual-only) and permissionMode to acceptEdits', () => {
    const schedule = inlineSchedule();
    delete schedule.cron;
    const schedules = parseSchedules(manifestOf('plugin', { schedules: [schedule] }));
    expect(schedules[0]?.cron).toBeNull();
    expect(schedules[0]?.timezone).toBeNull();
    expect(schedules[0]?.permissionMode).toBe('acceptEdits');
  });

  it.each(SCHEDULE_PERMISSION_MODES)('accepts the declared permission mode %s', (mode) => {
    const schedules = parseSchedules(
      manifestOf('plugin', { schedules: [inlineSchedule({ permissionMode: mode })] })
    );
    expect(schedules[0]?.permissionMode).toBe(mode);
  });

  it('rejects a permission mode outside the shared set', () => {
    expect(
      issuePaths(manifestOf('plugin', { schedules: [inlineSchedule({ permissionMode: 'yolo' })] }))
    ).toContain('schedules.0.permissionMode');
  });

  it('keeps the retired startDisabled visible so install-time can warn about it', () => {
    const schedules = parseSchedules(
      manifestOf('plugin', { schedules: [inlineSchedule({ startDisabled: true })] })
    );
    // Surviving the parse is the whole point — a stripped key is a silent
    // never-fires timer with nothing to explain it (DOR-607).
    expect(schedules[0]?.startDisabled).toBe(true);
    // And it never decides anything: startEnabled alone does.
    expect(schedules[0]?.startEnabled).toBe(false);
  });
});
