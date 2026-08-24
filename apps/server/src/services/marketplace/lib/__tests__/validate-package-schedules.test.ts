import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import { validatePackageSchedules, findShippedSkillDir } from '../validate-package-schedules.js';

let packagePath: string;

beforeEach(async () => {
  packagePath = await mkdtemp(path.join(tmpdir(), 'dorkos-schedule-validate-'));
});

afterEach(async () => {
  await rm(packagePath, { recursive: true, force: true });
});

/** Parse a plugin manifest with the given schedules through the real schema. */
function manifest(schedules: Record<string, unknown>[]): MarketplacePackageManifest {
  const parsed = MarketplacePackageManifestSchema.safeParse({
    schemaVersion: 1,
    name: 'tools',
    version: '1.0.0',
    type: 'plugin',
    description: 'Test package.',
    schedules,
  });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

/** Place a skill the package ships at the given relative directory. */
async function shipSkill(relDir: string, name: string): Promise<void> {
  const dir = path.join(packagePath, relDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A shipped skill.\n---\n\nBody.\n`,
    'utf-8'
  );
}

/** An inline schedule with the required three fields. */
function inline(extra: Record<string, unknown>): Record<string, unknown> {
  return { name: 'tick', description: 'Ticks.', prompt: 'Tick.', ...extra };
}

describe('cron and timezone validation', () => {
  it('accepts a package whose schedules read', async () => {
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([inline({ cron: '0 9 * * 1-5', timezone: 'America/New_York' })])
    );
    expect(problems).toEqual([]);
  });

  it('rejects a cron croner cannot read, naming the schedule and the value', async () => {
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([inline({ cron: 'every second tuesday' })])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Schedule 'tick'/);
    expect(problems[0]).toMatch(/every second tuesday/);
    expect(problems[0]).toMatch(/not a schedule DorkOS can read/);
  });

  it('rejects a timezone croner does not know, without blaming the cron', async () => {
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([inline({ cron: '0 9 * * *', timezone: 'Mars/Olympus_Mons' })])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not a timezone DorkOS knows/);
    // The cron is fine — saying otherwise would send the author to the wrong line.
    expect(problems[0]).not.toMatch(/not a schedule DorkOS can read/);
  });

  it('accepts a well-formed cron that never comes round (manual-only by design)', async () => {
    // February 31st: croner parses it happily and simply never fires. This is
    // the established way to write a schedule only a person triggers.
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([inline({ cron: '0 0 31 2 *' })])
    );
    expect(problems).toEqual([]);
  });

  it('accepts an absent cron (on-demand)', async () => {
    const problems = await validatePackageSchedules(packagePath, manifest([inline({})]));
    expect(problems).toEqual([]);
  });

  it('reports every bad schedule at once, not just the first', async () => {
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([
        { name: 'one', description: 'd', prompt: 'p', cron: 'nonsense' },
        { name: 'two', description: 'd', prompt: 'p', cron: 'also nonsense' },
      ])
    );
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toMatch(/'one'/);
    expect(problems.join(' ')).toMatch(/'two'/);
  });
});

describe('skillRef resolution', () => {
  it('accepts a skillRef the package ships under skills/', async () => {
    await shipSkill('skills', 'daily-report');
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([{ skillRef: 'daily-report', cron: '0 9 * * *' }])
    );
    expect(problems).toEqual([]);
  });

  it('rejects a skillRef the package does not ship, and says what to do', async () => {
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([{ skillRef: 'never-shipped' }])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not ship/);
    expect(problems[0]).toMatch(/skills\/never-shipped\/SKILL\.md/);
  });

  it('rejects a directory that exists but has no SKILL.md', async () => {
    await mkdir(path.join(packagePath, 'skills', 'hollow'), { recursive: true });
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([{ skillRef: 'hollow' }])
    );
    expect(problems).toHaveLength(1);
  });

  it('does not accept a skill vendored inside node_modules', async () => {
    await shipSkill(path.join('skills', 'node_modules'), 'borrowed');
    const problems = await validatePackageSchedules(
      packagePath,
      manifest([{ skillRef: 'borrowed' }])
    );
    expect(problems).toHaveLength(1);
  });
});

describe('findShippedSkillDir', () => {
  it.each(['skills', '.claude/skills', 'commands', '.claude/commands'])(
    'finds a skill under %s',
    async (dir) => {
      await shipSkill(dir, 'findable');
      const found = await findShippedSkillDir(packagePath, 'findable');
      expect(found).toBe(path.join(packagePath, dir, 'findable'));
    }
  );

  it('returns null when the skill is nowhere', async () => {
    expect(await findShippedSkillDir(packagePath, 'absent')).toBeNull();
  });
});

describe('types with no schedules slot', () => {
  it('finds nothing to check on an adapter', async () => {
    const adapter = MarketplacePackageManifestSchema.parse({
      schemaVersion: 1,
      name: 'slack',
      version: '1.0.0',
      type: 'adapter',
      adapterType: 'slack',
      description: 'Slack transport.',
    });
    expect(await validatePackageSchedules(packagePath, adapter)).toEqual([]);
  });
});
