import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '@dorkos/skills/frontmatter';
import { isUnmodifiedSeededSkill, seedOperatingSkills } from '../seed.js';
import { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION } from '../pack.js';

const UMBRELLA = 'operating-dorkos';

describe('seedOperatingSkills', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'operating-skills-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const skillFile = (name: string) => path.join(root, '.agents', 'skills', name, 'SKILL.md');

  it('creates the whole pack in a fresh workspace', async () => {
    const result = await seedOperatingSkills(root);

    expect(result.outcomes).toHaveLength(OPERATING_SKILLS_PACK.length);
    expect(result.outcomes.every((o) => o.action === 'created')).toBe(true);

    for (const skill of OPERATING_SKILLS_PACK) {
      const raw = await readFile(skillFile(skill.name), 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      expect(data.name).toBe(skill.name);
      expect(content.trim()).toBe(skill.body.trim());
      expect((data.metadata as Record<string, string>).dorkosPack).toBe('operating-dorkos');
    }
  });

  it('leaves seeded files unchanged on a re-seed', async () => {
    await seedOperatingSkills(root);
    const before = await readFile(skillFile(UMBRELLA), 'utf-8');

    const result = await seedOperatingSkills(root);
    expect(result.outcomes.every((o) => o.action === 'unchanged')).toBe(true);

    const after = await readFile(skillFile(UMBRELLA), 'utf-8');
    expect(after).toBe(before);
  });

  it('never clobbers a user-modified seeded skill', async () => {
    await seedOperatingSkills(root);

    // Simulate the user editing the body of a seeded skill.
    const original = await readFile(skillFile(UMBRELLA), 'utf-8');
    const edited = original.replace(
      '# Operating DorkOS',
      '# Operating DorkOS\n\nMY OWN NOTES — keep these.'
    );
    expect(edited).not.toBe(original);
    await writeFile(skillFile(UMBRELLA), edited, 'utf-8');

    const result = await seedOperatingSkills(root);
    const umbrella = result.outcomes.find((o) => o.name === UMBRELLA);
    expect(umbrella?.action).toBe('preserved');

    const after = await readFile(skillFile(UMBRELLA), 'utf-8');
    expect(after).toBe(edited);
    expect(after).toContain('MY OWN NOTES');
  });

  it('never clobbers a foreign skill that shares the name', async () => {
    // A user authored their own `operating-dorkos` skill (no pack stamp).
    const dir = path.join(root, '.agents', 'skills', UMBRELLA);
    await mkdir(dir, { recursive: true });
    const foreign = stringifyFrontmatter('My own operating notes.', {
      name: UMBRELLA,
      description: 'A hand-written skill I control.',
    });
    await writeFile(path.join(dir, 'SKILL.md'), foreign, 'utf-8');

    const result = await seedOperatingSkills(root);
    expect(result.outcomes.find((o) => o.name === UMBRELLA)?.action).toBe('preserved');

    const after = await readFile(skillFile(UMBRELLA), 'utf-8');
    expect(after).toBe(foreign);
  });

  it('upgrades an unmodified seeded skill stamped with an older pack version', async () => {
    await seedOperatingSkills(root);

    // Rewrite the stamp to an older version, preserving the body hash so the file
    // still reads as unmodified-since-seed. Build a fresh metadata object rather
    // than mutating the parse result.
    const { data, content } = parseFrontmatter(await readFile(skillFile(UMBRELLA), 'utf-8'));
    const meta = { ...(data.metadata as Record<string, string>), dorkosPackVersion: '0' };
    await writeFile(
      skillFile(UMBRELLA),
      stringifyFrontmatter(content, { ...data, metadata: meta }),
      'utf-8'
    );

    const result = await seedOperatingSkills(root);
    expect(result.outcomes.find((o) => o.name === UMBRELLA)?.action).toBe('upgraded');

    // Assert on the raw file: the stamp was rewritten to the current pack version.
    // Read the version from the pack rather than hardcoding it, so a content bump
    // does not need this test edited to stay honest.
    const after = await readFile(skillFile(UMBRELLA), 'utf-8');
    expect(after).toContain(`dorkosPackVersion: '${OPERATING_SKILLS_VERSION}'`);
  });

  it('re-seeds every skill once, and only once, after a version bump', async () => {
    // The idempotence contract the whole seeder rests on, exercised across a bump:
    // the first pass after a bump upgrades every unmodified file, and the pass
    // after that touches nothing. Simulated by rewinding every stamp to '0' while
    // keeping each body hash intact, which is exactly what an older pack left on
    // disk.
    await seedOperatingSkills(root);
    for (const skill of OPERATING_SKILLS_PACK) {
      const { data, content } = parseFrontmatter(await readFile(skillFile(skill.name), 'utf-8'));
      const meta = { ...(data.metadata as Record<string, string>), dorkosPackVersion: '0' };
      await writeFile(
        skillFile(skill.name),
        stringifyFrontmatter(content, { ...data, metadata: meta }),
        'utf-8'
      );
    }

    const upgrade = await seedOperatingSkills(root);
    expect(upgrade.outcomes.map((o) => o.action)).toEqual(
      OPERATING_SKILLS_PACK.map(() => 'upgraded')
    );

    const settled = await seedOperatingSkills(root);
    expect(settled.outcomes.map((o) => o.action)).toEqual(
      OPERATING_SKILLS_PACK.map(() => 'unchanged')
    );

    // And the upgraded bodies really are the current pack, not the older text.
    for (const skill of OPERATING_SKILLS_PACK) {
      const { content } = parseFrontmatter(await readFile(skillFile(skill.name), 'utf-8'));
      expect(content.trim()).toBe(skill.body.trim());
    }
  });

  describe('a skill with supporting files', () => {
    // Read from the pack, not named, so the cases follow whichever skill ships files.
    const withFiles = OPERATING_SKILLS_PACK.find((s) => s.files && Object.keys(s.files).length);
    if (!withFiles?.files) throw new Error('No pack skill ships supporting files.');
    const [firstFile] = Object.keys(withFiles.files);
    const supportingFile = (file: string) =>
      path.join(root, '.agents', 'skills', withFiles.name, file);

    /** Rewind every stamp to version 0, keeping each hash, as an older pack left it. */
    async function rewindStamps(): Promise<void> {
      for (const skill of OPERATING_SKILLS_PACK) {
        const { data, content } = parseFrontmatter(await readFile(skillFile(skill.name), 'utf-8'));
        const meta = { ...(data.metadata as Record<string, string>), dorkosPackVersion: '0' };
        await writeFile(
          skillFile(skill.name),
          stringifyFrontmatter(content, { ...data, metadata: meta }),
          'utf-8'
        );
      }
    }

    it('reports every file it wrote, so a failed scaffold can undo them all', async () => {
      const first = await seedOperatingSkills(root);
      const outcome = first.outcomes.find((o) => o.name === withFiles.name)!;
      expect([...outcome.written].sort()).toEqual(
        [skillFile(withFiles.name), ...Object.keys(withFiles.files!).map(supportingFile)].sort()
      );
      const again = await seedOperatingSkills(root);
      expect(again.outcomes.every((o) => o.written.length === 0)).toBe(true);
    });

    it('writes each one beside SKILL.md, byte for byte', async () => {
      await seedOperatingSkills(root);
      for (const [file, content] of Object.entries(withFiles.files!)) {
        expect(await readFile(supportingFile(file), 'utf-8')).toBe(content);
      }
    });

    it('never overwrites an edited supporting file on upgrade', async () => {
      await seedOperatingSkills(root);
      const edited = `${withFiles.files![firstFile!]}\nMY OWN NOTES, keep these.\n`;
      await writeFile(supportingFile(firstFile!), edited, 'utf-8');
      await rewindStamps();

      const result = await seedOperatingSkills(root);
      expect(result.outcomes.find((o) => o.name === withFiles.name)?.action).toBe('preserved');
      expect(await readFile(supportingFile(firstFile!), 'utf-8')).toBe(edited);
    });

    it('treats a deleted supporting file as the person`s change and leaves it gone', async () => {
      await seedOperatingSkills(root);
      await rm(supportingFile(firstFile!));
      await rewindStamps();

      const result = await seedOperatingSkills(root);
      expect(result.outcomes.find((o) => o.name === withFiles.name)?.action).toBe('preserved');
      await expect(readFile(supportingFile(firstFile!), 'utf-8')).rejects.toThrow();
    });

    it('never writes over a supporting file it did not seed', async () => {
      // A person's own file sits where the pack would put one, before any seed.
      await mkdir(path.dirname(supportingFile(firstFile!)), { recursive: true });
      await writeFile(supportingFile(firstFile!), 'mine', 'utf-8');

      const result = await seedOperatingSkills(root);
      expect(result.outcomes.find((o) => o.name === withFiles.name)?.action).toBe('preserved');
      expect(await readFile(supportingFile(firstFile!), 'utf-8')).toBe('mine');
    });
  });
});

describe('isUnmodifiedSeededSkill', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'operating-skills-unmodified-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recognises a file the seeder wrote and nobody touched', async () => {
    await seedOperatingSkills(root);
    const file = path.join(root, '.agents', 'skills', OPERATING_SKILLS_PACK[0]!.name, 'SKILL.md');

    expect(isUnmodifiedSeededSkill(file, await readFile(file, 'utf-8'))).toBe(true);
  });

  it('refuses an edited copy, a person`s own skill, and something unparseable', async () => {
    await seedOperatingSkills(root);
    const file = path.join(root, '.agents', 'skills', OPERATING_SKILLS_PACK[0]!.name, 'SKILL.md');
    const seeded = await readFile(file, 'utf-8');

    expect(isUnmodifiedSeededSkill(file, `${seeded}\nMy own note.\n`)).toBe(false);
    expect(
      isUnmodifiedSeededSkill(file, '---\nname: mine\ndescription: mine\n---\n\n# Mine\n')
    ).toBe(false);
    expect(isUnmodifiedSeededSkill(file, 'not a skill at all')).toBe(false);
  });
});
