import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import { ScheduleBlockSchema } from '@dorkos/skills/schedule-schema';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import { materializePackageSchedules } from '../materialize-schedules.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof materializePackageSchedules>[0]['logger'];

let root: string;
let dorkHome: string;
let projectPath: string;
let installPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dorkos-materialize-'));
  dorkHome = path.join(root, 'dork-home');
  projectPath = path.join(root, 'project');
  installPath = path.join(root, 'install', 'nightly-tools');
  await mkdir(dorkHome, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  await mkdir(installPath, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Parse a manifest through the real schema, so tests never assert on a shape zod would reject. */
function manifest(schedules: Record<string, unknown>[]): MarketplacePackageManifest {
  const parsed = MarketplacePackageManifestSchema.safeParse({
    schemaVersion: 1,
    name: 'nightly-tools',
    version: '1.0.0',
    type: 'plugin',
    description: 'Tools that run overnight.',
    schedules,
  });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

/** Write a skill the package "ships" into its install root. */
async function shipSkill(name: string, frontmatter: string, body: string): Promise<string> {
  const dir = path.join(installPath, 'skills', name);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  await writeFile(filePath, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  return filePath;
}

/** Read a generated/injected SKILL.md's frontmatter and body. */
async function readSkill(
  filePath: string
): Promise<{ data: Record<string, unknown>; body: string }> {
  const parsed = matter(await readFile(filePath, 'utf-8'));
  return { data: parsed.data, body: parsed.content.trim() };
}

describe('inline declarations generate a skill file', () => {
  it('writes the schedule block, the body, and the provenance stamp', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([
        {
          name: 'Nightly Tidy',
          description: 'Tidy the working tree.',
          prompt: 'Look over the working tree and tidy anything stale.',
          cron: '0 3 * * *',
          timezone: 'America/New_York',
        },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings).toEqual([]);
    const dirPath = path.join(projectPath, '.agents', 'skills', 'nightly-tidy');
    expect(result.generatedPaths).toEqual([dirPath]);

    const { data, body } = await readSkill(path.join(dirPath, 'SKILL.md'));
    expect(data.name).toBe('nightly-tidy');
    expect(data.description).toBe('Tidy the working tree.');
    // The prompt becomes the body — the file teaches the same thing it runs.
    expect(body).toBe('Look over the working tree and tidy anything stale.');
    expect(data.schedule).toEqual({
      cron: '0 3 * * *',
      timezone: 'America/New_York',
      enabled: false,
      origin: 'plugin',
      shape: 'nightly-tools',
    });
  });

  it('writes ONLY author-typed fields — no schema defaults leak into the file', async () => {
    await materializePackageSchedules({
      manifest: manifest([
        {
          name: 'plain',
          description: 'A schedule with every value left at its default.',
          prompt: 'Do the thing.',
        },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    const { data } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'plain', 'SKILL.md')
    );
    const schedule = data.schedule as Record<string, unknown>;
    // `timezone: UTC` and `permissions: acceptEdits` are the schema's own
    // defaults; writing them would grow a file the author never typed.
    expect(schedule).not.toHaveProperty('timezone');
    expect(schedule).not.toHaveProperty('permissions');
    expect(schedule).not.toHaveProperty('cron'); // absent cron = manual-only
    expect(schedule).not.toHaveProperty('prompt');
    // `enabled: false` IS written: the block's default is `true`, so leaving it
    // out would arm the schedule the moment somebody approved it.
    expect(schedule.enabled).toBe(false);
  });

  it('maps startEnabled onto schedule.enabled', async () => {
    await materializePackageSchedules({
      manifest: manifest([
        {
          name: 'eager',
          description: 'Wants to be running.',
          prompt: 'Go.',
          startEnabled: true,
        },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    const { data } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'eager', 'SKILL.md')
    );
    // Asserted through the real schema, not on the raw key: `enabled: true` is
    // the block's own default, so `scheduleToFrontmatter` deliberately omits it
    // (author-typed fields only). The key being ABSENT is what "enabled" looks
    // like on disk — checking for a literal `true` would be checking that the
    // writer stopped doing the thing it exists to do.
    expect(data.schedule).not.toHaveProperty('enabled');
    expect(ScheduleBlockSchema.parse(data.schedule).enabled).toBe(true);
  });

  it('writes enabled: false explicitly, because absence would mean armed', async () => {
    await materializePackageSchedules({
      manifest: manifest([{ name: 'idle', description: 'Stays off.', prompt: 'Go.' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    const { data } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'idle', 'SKILL.md')
    );
    expect((data.schedule as Record<string, unknown>).enabled).toBe(false);
    expect(ScheduleBlockSchema.parse(data.schedule).enabled).toBe(false);
  });

  it('generates into the global skills root when the install is not project-scoped', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([{ name: 'global-tick', description: 'Everywhere.', prompt: 'Tick.' }]),
      installPath,
      dorkHome,
      logger,
    });

    expect(result.generatedPaths).toEqual([path.join(dorkHome, 'skills', 'global-tick')]);
  });

  it('clamps a bypassPermissions request and says so', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([
        {
          name: 'greedy',
          description: 'Asks for everything.',
          prompt: 'Go.',
          permissionMode: 'bypassPermissions',
        },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    const { data } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'greedy', 'SKILL.md')
    );
    expect((data.schedule as Record<string, unknown>).permissions).not.toBe('bypassPermissions');
    expect(result.warnings.join(' ')).toMatch(/every approval prompt turned off/);
  });

  it('warns about the retired startDisabled without letting it decide anything', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([
        {
          name: 'stale-key',
          description: 'Written against the old schema.',
          prompt: 'Go.',
          startDisabled: false,
        },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings.join(' ')).toMatch(/startDisabled/);
    const { data } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'stale-key', 'SKILL.md')
    );
    // startDisabled: false does NOT mean "start enabled" — startEnabled alone decides.
    expect((data.schedule as Record<string, unknown>).enabled).toBe(false);
  });
});

describe('skillRef declarations inject into the shipped skill', () => {
  it('adds the schedule block and preserves the rest of the file verbatim', async () => {
    const filePath = await shipSkill(
      'daily-report',
      ['name: daily-report', 'description: Report on yesterday.', 'allowed-tools: Read, Bash'].join(
        '\n'
      ),
      '# Daily report\n\nGather yesterday and summarize it.'
    );

    const result = await materializePackageSchedules({
      manifest: manifest([{ skillRef: 'daily-report', cron: '0 9 * * 1-5' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings).toEqual([]);
    // Nothing new is generated — the shipped file IS the schedule.
    expect(result.generatedPaths).toEqual([]);

    const { data, body } = await readSkill(filePath);
    expect(data.schedule).toEqual({
      cron: '0 9 * * 1-5',
      enabled: false,
      origin: 'plugin',
      shape: 'nightly-tools',
    });
    // The author's own frontmatter and body survive untouched.
    expect(data['allowed-tools']).toBe('Read, Bash');
    expect(data.description).toBe('Report on yesterday.');
    expect(body).toBe('# Daily report\n\nGather yesterday and summarize it.');
  });

  it('keeps every frontmatter key and value the skill schema does not know', async () => {
    // Parsing through SkillFrontmatterSchema would strip all of these; reading
    // with gray-matter is what keeps them. Each is a distinct shape the schema
    // has no field for, so a regression that reintroduces schema-parsing reddens
    // here rather than passing on a single lenient key.
    const filePath = await shipSkill(
      'exotic',
      [
        'name: exotic',
        'description: Has unusual keys.',
        'x-vendor-thing: keep-me',
        'metadata:',
        '  team: platform',
        '  tier: "2"',
        'allowed-tools: Read, Bash',
        'disable-model-invocation: true',
        'arguments:',
        '  - first',
        '  - second',
        'nested:',
        '  deep:',
        '    value: 42',
      ].join('\n'),
      'Body.'
    );

    await materializePackageSchedules({
      manifest: manifest([{ skillRef: 'exotic' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    const { data } = await readSkill(filePath);
    expect(data['x-vendor-thing']).toBe('keep-me');
    expect(data.metadata).toEqual({ team: 'platform', tier: '2' });
    expect(data['allowed-tools']).toBe('Read, Bash');
    expect(data['disable-model-invocation']).toBe(true);
    expect(data.arguments).toEqual(['first', 'second']);
    expect(data.nested).toEqual({ deep: { value: 42 } });
    expect(data.schedule).toBeDefined();
  });

  it('says so when it resets a schedule block that had been changed', async () => {
    // An update reinstalls the package and rewrites this block. If a person had
    // tuned the schedule in between, that edit disappears — the install still
    // wins, but silence would leave a deliberate change with nothing to trace it
    // to.
    const filePath = await shipSkill(
      'tuned',
      [
        'name: tuned',
        'description: Someone moved its hour.',
        'schedule:',
        '  cron: 0 17 * * *',
        '  permissions: plan',
      ].join('\n'),
      'Body.'
    );

    const result = await materializePackageSchedules({
      manifest: manifest([{ skillRef: 'tuned', cron: '0 9 * * *' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings.join(' ')).toMatch(/was reset to what the package declares/);
    const { data } = await readSkill(filePath);
    expect((data.schedule as Record<string, unknown>).cron).toBe('0 9 * * *');
  });

  it('stays quiet when the block on disk already matches the declaration', async () => {
    await shipSkill('steady', ['name: steady', 'description: Unchanged.'].join('\n'), 'Body.');
    const decl = manifest([{ skillRef: 'steady', cron: '0 9 * * *' }]);

    await materializePackageSchedules({
      manifest: decl,
      installPath,
      dorkHome,
      projectPath,
      logger,
    });
    // Second pass: a reinstall of the same version must not invent a warning.
    const again = await materializePackageSchedules({
      manifest: decl,
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(again.warnings).toEqual([]);
  });

  it('finds a skill nested below the skills root', async () => {
    const dir = path.join(installPath, 'skills', 'group', 'nested-skill');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: nested-skill\ndescription: Nested.\n---\n\nBody.\n',
      'utf-8'
    );

    const result = await materializePackageSchedules({
      manifest: manifest([{ skillRef: 'nested-skill' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings).toEqual([]);
    const { data } = await readSkill(path.join(dir, 'SKILL.md'));
    expect(data.schedule).toBeDefined();
  });
});

describe('the skills root is never the target', () => {
  // A name with nothing slug-able in it slugifies to '', and `path.join(root,
  // '')` is the ROOT. Everything downstream then treats the person's whole
  // skills directory as one skill dir: the transaction moves it aside, drops a
  // single SKILL.md where it stood, and deletes the backup on success — after
  // which the root is on the uninstall receipt to be deleted later.
  it.each(['!!!', '..', '🌟🌟🌟', '---', '   '])(
    'refuses the name %j instead of consuming the skills root',
    async (name) => {
      // Pre-existing skills that must survive untouched.
      const neighbour = path.join(projectPath, '.agents', 'skills', 'neighbour');
      await mkdir(neighbour, { recursive: true });
      await writeFile(path.join(neighbour, 'SKILL.md'), 'mine', 'utf-8');

      const raw = {
        schemaVersion: 1,
        name: 'nightly-tools',
        version: '1.0.0',
        type: 'plugin',
        description: 'Hostile names.',
        schedules: [{ name, description: 'd', prompt: 'p' }],
      } as unknown as MarketplacePackageManifest;

      const result = await materializePackageSchedules({
        manifest: raw,
        installPath,
        dorkHome,
        projectPath,
        logger,
      });

      const skillsRoot = path.join(projectPath, '.agents', 'skills');
      // Nothing generated, and above all the ROOT is not on the receipt.
      expect(result.generatedPaths).toEqual([]);
      expect(result.generatedPaths).not.toContain(skillsRoot);
      expect(result.warnings.join(' ')).toMatch(/no letters or numbers/);
      // The neighbour is still there, with its contents.
      expect(await readFile(path.join(neighbour, 'SKILL.md'), 'utf-8')).toBe('mine');
      // And no SKILL.md was dropped into the root itself.
      expect(await readdir(skillsRoot)).toEqual(['neighbour']);
    }
  );
});

describe('an occupied directory is never replaced', () => {
  /** Everything that can sit at the target path without being a readable skill of ours. */
  it('spares a directory holding loose files but no SKILL.md', async () => {
    const target = path.join(projectPath, '.agents', 'skills', 'nightly');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'draft.md'), 'my draft', 'utf-8');
    await writeFile(path.join(target, 'notes.txt'), 'my notes', 'utf-8');

    const result = await materializePackageSchedules({
      manifest: manifest([{ name: 'nightly', description: 'Package version.', prompt: 'Go.' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.generatedPaths).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/already there/);
    // Both files survive — this is the case that read as "absent" before.
    expect(await readFile(path.join(target, 'draft.md'), 'utf-8')).toBe('my draft');
    expect(await readFile(path.join(target, 'notes.txt'), 'utf-8')).toBe('my notes');
  });

  it('spares a directory whose entry file is named something else', async () => {
    const target = path.join(projectPath, '.agents', 'skills', 'nightly');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'readme.md'), 'reference', 'utf-8');

    const result = await materializePackageSchedules({
      manifest: manifest([{ name: 'nightly', description: 'd', prompt: 'p' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.generatedPaths).toEqual([]);
    expect(await readFile(path.join(target, 'readme.md'), 'utf-8')).toBe('reference');
  });

  it('spares an empty directory a person made', async () => {
    const target = path.join(projectPath, '.agents', 'skills', 'nightly');
    await mkdir(target, { recursive: true });

    const result = await materializePackageSchedules({
      manifest: manifest([{ name: 'nightly', description: 'd', prompt: 'p' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.generatedPaths).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/already there/);
  });

  it('spares a SKILL.md whose frontmatter cannot be parsed', async () => {
    const target = path.join(projectPath, '.agents', 'skills', 'nightly');
    await mkdir(target, { recursive: true });
    const broken = '---\nname: [unclosed\n  bad: : :\n---\nbody\n';
    await writeFile(path.join(target, 'SKILL.md'), broken, 'utf-8');

    const result = await materializePackageSchedules({
      manifest: manifest([{ name: 'nightly', description: 'd', prompt: 'p' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.generatedPaths).toEqual([]);
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf-8')).toBe(broken);
  });
});

describe('a shape is never materialized here', () => {
  it('leaves a shape manifest entirely alone', async () => {
    // `applyShape` stands a Shape's schedules up itself, with the agent binding
    // resolved and the Shape's own provenance. Doing it here too would make two
    // files from one declaration, and this one would be invisible to Shape
    // teardown.
    const shape = MarketplacePackageManifestSchema.parse({
      schemaVersion: 1,
      name: 'linear-ops',
      version: '1.0.0',
      type: 'shape',
      description: 'A place.',
      agents: [{ ref: 'tender', affinity: 'default', matchName: 'Tender' }],
      schedules: [
        {
          name: 'inbox-tick',
          description: 'Poll the inbox.',
          prompt: 'Tick.',
          cron: '*/15 * * * *',
          agentRef: 'tender',
        },
      ],
    });

    const result = await materializePackageSchedules({
      manifest: shape,
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result).toEqual({ generatedPaths: [], warnings: [] });
    await expect(readdir(path.join(projectPath, '.agents'))).rejects.toThrow();
  });
});

describe('collisions and failures', () => {
  it("refuses to overwrite a person's own skill of the same name", async () => {
    const existingDir = path.join(projectPath, '.agents', 'skills', 'nightly-tidy');
    await mkdir(existingDir, { recursive: true });
    const mine = '---\nname: nightly-tidy\ndescription: Mine, not the package.\n---\n\nMy body.\n';
    await writeFile(path.join(existingDir, 'SKILL.md'), mine, 'utf-8');

    const result = await materializePackageSchedules({
      manifest: manifest([
        { name: 'nightly-tidy', description: 'The package version.', prompt: 'Package prompt.' },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.generatedPaths).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/already there/);
    // Byte-for-byte untouched.
    expect(await readFile(path.join(existingDir, 'SKILL.md'), 'utf-8')).toBe(mine);
  });

  it('overwrites its own earlier generated file on reinstall', async () => {
    const decl = [{ name: 'tick', description: 'v1', prompt: 'v1 prompt' }];
    await materializePackageSchedules({
      manifest: manifest(decl),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    const result = await materializePackageSchedules({
      manifest: manifest([{ name: 'tick', description: 'v2', prompt: 'v2 prompt' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings).toEqual([]);
    const { data, body } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'tick', 'SKILL.md')
    );
    expect(data.description).toBe('v2');
    expect(body).toBe('v2 prompt');
  });

  it('leaves no partial directory when a skillRef target vanished after validation', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([{ skillRef: 'never-shipped' }]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.generatedPaths).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/no longer contains a skill named/);
    // The failure of one entry must not leave a stray skills root behind.
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const entries = await readdir(skillsRoot).catch(() => []);
    expect(entries).toEqual([]);
  });

  it('places the entries it can when a sibling entry fails', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([
        { skillRef: 'never-shipped' },
        { name: 'survivor', description: 'Should still land.', prompt: 'Go.' },
      ]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.generatedPaths).toEqual([
      path.join(projectPath, '.agents', 'skills', 'survivor'),
    ]);
  });

  it('survives a declaration that never went through the schema', async () => {
    // Not every manifest reaching the materializer was parsed: one read off disk
    // by an older build arrives with the keys the schema would have defaulted
    // simply missing. Handing an `undefined` to `scheduleToFrontmatter` makes
    // js-yaml throw ("unacceptable kind of an object to dump"), which took the
    // whole schedule down before the fields were coalesced.
    const raw = {
      schemaVersion: 1,
      name: 'nightly-tools',
      version: '1.0.0',
      type: 'plugin',
      description: 'Never parsed.',
      schedules: [{ name: 'bare', description: 'No defaults applied.', prompt: 'Go.' }],
    } as unknown as MarketplacePackageManifest;

    const result = await materializePackageSchedules({
      manifest: raw,
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result.warnings).toEqual([]);
    const { data } = await readSkill(
      path.join(projectPath, '.agents', 'skills', 'bare', 'SKILL.md')
    );
    const schedule = data.schedule as Record<string, unknown>;
    // The safe answers, identical to what the schema would have supplied.
    expect(schedule.enabled).toBe(false);
    expect(schedule).not.toHaveProperty('permissions'); // acceptEdits, the default
    expect(schedule).not.toHaveProperty('cron'); // on-demand
  });

  it('does nothing at all for a package that declares no schedules', async () => {
    const result = await materializePackageSchedules({
      manifest: manifest([]),
      installPath,
      dorkHome,
      projectPath,
      logger,
    });

    expect(result).toEqual({ generatedPaths: [], warnings: [] });
    await expect(readdir(path.join(projectPath, '.agents'))).rejects.toThrow();
  });
});
