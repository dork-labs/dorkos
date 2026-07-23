import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { seedOperatingSkills } from '../seed.js';
import { OPERATING_SKILLS_PACK } from '../pack.js';

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
      const { data, content } = matter(raw);
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
    const foreign = matter.stringify('My own operating notes.', {
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
    // than mutating gray-matter's parse result (it caches and returns a shared,
    // mutable object keyed by input string).
    const { data, content } = matter(await readFile(skillFile(UMBRELLA), 'utf-8'));
    const meta = { ...(data.metadata as Record<string, string>), dorkosPackVersion: '0' };
    await writeFile(
      skillFile(UMBRELLA),
      matter.stringify(content, { ...data, metadata: meta }),
      'utf-8'
    );

    const result = await seedOperatingSkills(root);
    expect(result.outcomes.find((o) => o.name === UMBRELLA)?.action).toBe('upgraded');

    // Assert on the raw file: the stamp was rewritten to the current pack version.
    const after = await readFile(skillFile(UMBRELLA), 'utf-8');
    expect(after).toContain("dorkosPackVersion: '2'");
  });
});
