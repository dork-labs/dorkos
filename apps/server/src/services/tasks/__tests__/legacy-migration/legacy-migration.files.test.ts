/**
 * The boot migration's effect on disk (DOR-1486): the rewritten files, the
 * template gallery, the system files beside them, and stray legacy fields in a
 * skills root.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { loadTemplates, resolveTemplatesDir } from '../../task-templates.js';
import { globalTaskRoots } from '../../skills-roots.js';
import { legacyFile, scheduleIn, useLegacyHome, writeAt } from './legacy-migration.fixtures.js';

describe('the boot migration: the files on disk', () => {
  const h = useLegacyHome();

  describe('the file on disk', () => {
    it('rewrites the frontmatter into a schedule block, keeps the body, and moves the directory', async () => {
      // `scheduleIn` returning exactly `{ cron }` is also the proof that the
      // rewrite wrote only what the author typed: parsing fills `timezone`,
      // `enabled` and `permissions` in, and a migration that wrote the parsed
      // form back would grow three lines in every hand-written file.
      await h.seedGlobalLegacy('nightly-sweep', { cron: '0 3 * * *' });

      const report = await h.migrate();

      expect(report.moved).toBe(1);
      const moved = h.globalDestination('nightly-sweep');
      expect(await scheduleIn(moved)).toEqual({ cron: '0 3 * * *' });
      // The body byte for byte, which is what a run actually sends.
      expect(readRawFrontmatter(await fs.readFile(moved, 'utf-8'))?.body).toBe('Do the thing.');
      // The old home is gone, not merely emptied of its frontmatter.
      await expect(fs.access(path.join(h.dorkHome, 'tasks', 'nightly-sweep'))).rejects.toThrow();
    });

    it('keeps the non-default fields, including the Shape provenance marker', async () => {
      const fields = {
        cron: '0 6 * * *',
        timezone: 'America/New_York',
        'max-runtime': '30m',
        permissions: 'plan',
        origin: 'shape',
        shape: 'linear-ops',
      };
      await h.seedGlobalLegacy('shaped', fields);

      await h.migrate();

      expect(await scheduleIn(h.globalDestination('shaped'))).toEqual(fields);
    });

    it('carries a whole skill directory across, not just its SKILL.md', async () => {
      // A skill may ship scripts and references beside its SKILL.md. The move is
      // a directory rename for this reason; writing the new file and deleting the
      // old directory would take a person's helper scripts with it.
      await h.seedGlobalLegacy('with-extras', { cron: '0 3 * * *' });
      await writeAt(
        path.join(h.dorkHome, 'tasks', 'with-extras', 'scripts', 'run.sh'),
        '#!/bin/sh\n'
      );

      await h.migrate();

      await expect(
        fs.readFile(path.join(h.dorkHome, 'skills', 'with-extras', 'scripts', 'run.sh'), 'utf-8')
      ).resolves.toContain('#!/bin/sh');
    });

    it("moves a project's schedules into its .agents/skills, not the global root", async () => {
      await h.seedProjectLegacy('project-tick', { cron: '*/10 * * * *' });

      const report = await h.migrate();

      expect(report.moved).toBe(1);
      const moved = path.join(h.projectPath, '.agents', 'skills', 'project-tick', SKILL_FILENAME);
      expect(await scheduleIn(moved)).toEqual({ cron: '*/10 * * * *' });
      await expect(fs.access(h.globalDestination('project-tick'))).rejects.toThrow();
    });
  });

  describe('the template gallery', () => {
    /** Write a template where an older build put the gallery. */
    async function legacyTemplate(name: string, cron: string): Promise<void> {
      await writeAt(
        path.join(h.dorkHome, 'tasks', 'templates', name, SKILL_FILENAME),
        legacyFile(name, { cron })
      );
    }

    it('moves the seeded and the hand-written templates together', async () => {
      // One of the DorkOS seeds, and one the person wrote themselves, which is
      // the half a wholesale re-seed would lose.
      await legacyTemplate('daily-health-check', '0 9 * * 1-5');
      await legacyTemplate('my-own-template', '0 8 * * *');

      const report = await h.migrate();

      expect(report.templates).toBe(2);
      const names = (await fs.readdir(resolveTemplatesDir(h.dorkHome))).sort();
      expect(names).toEqual(['daily-health-check', 'my-own-template']);

      // ...and they still have their crons. The gallery reads a cron out of the
      // `schedule:` block, so a template MOVED but not REWRITTEN arrives with
      // its cron in a key nothing reads — and every seeded template on every
      // installation older than this wave is in that shape, so asserting only
      // the names would have passed while the whole gallery lost its schedules.
      const loaded = await loadTemplates(h.dorkHome);
      expect(loaded.map((t) => [t.name, t.cron]).sort()).toEqual([
        ['daily-health-check', '0 9 * * 1-5'],
        ['my-own-template', '0 8 * * *'],
      ]);
    });

    it('does not turn a template into a schedule on the way past', async () => {
      // `templates/` is a container, and the global root reserves the name. A row
      // for it would fire on a clock with no reconciler behind it, and deleting
      // that row would take every template with it.
      await legacyTemplate('daily-health-check', '0 9 * * 1-5');

      await h.migrate();
      await h.discover(globalTaskRoots(h.dorkHome));

      expect(h.store.getTasks()).toHaveLength(0);
    });

    it('leaves a template already at the destination alone, even an empty one', async () => {
      // POSIX `rename` replaces an EMPTY destination directory without
      // complaint, so relying on its errno would silently overwrite a template
      // a person had emptied out.
      const destination = path.join(resolveTemplatesDir(h.dorkHome), 'daily-health-check');
      await fs.mkdir(destination, { recursive: true });
      await legacyTemplate('daily-health-check', '0 9 * * 1-5');

      const report = await h.migrate();

      expect(report.templates).toBe(0);
      expect(await fs.readdir(destination)).toEqual([]);
    });
  });

  describe('the system files that share the legacy directory', () => {
    it('leaves scheduler.lock and presets.json exactly where they are', async () => {
      // `<dorkHome>/tasks/` is not deleted, because it is still a directory
      // DorkOS uses — it just holds no schedules any more.
      await writeAt(path.join(h.dorkHome, 'tasks', 'scheduler.lock'), '{}');
      await writeAt(path.join(h.dorkHome, 'tasks', 'presets.json'), '[]');
      await h.seedGlobalLegacy('nightly-sweep', { cron: '0 3 * * *' });

      await h.migrate();

      await expect(
        fs.readFile(path.join(h.dorkHome, 'tasks', 'scheduler.lock'), 'utf-8')
      ).resolves.toBe('{}');
      await expect(
        fs.readFile(path.join(h.dorkHome, 'tasks', 'presets.json'), 'utf-8')
      ).resolves.toBe('[]');
    });
  });

  describe('stray legacy fields on a file that is already in a skills root', () => {
    it('folds them into a block, so the schedule its author wrote finally exists', async () => {
      // The rarer half of detection. The unified schema drops keys it does not
      // know, so this file parses perfectly and is silently NOT a schedule —
      // exactly the failure the ADR names as this design's worst case.
      await writeAt(
        h.globalDestination('hand-written'),
        legacyFile('hand-written', { cron: '0 2 * * *' })
      );

      const report = await h.migrate();

      expect(report.foldedInPlace).toBe(1);
      expect(await scheduleIn(h.globalDestination('hand-written'))).toEqual({ cron: '0 2 * * *' });
    });

    it.each([
      // `permissions: plan` on a skill with no cron is an ordinary thing to
      // write and says nothing about scheduling. Taking it as evidence gave the
      // person a phantom parked schedule AND rewrote a file DorkOS was never
      // asked to own (review, I3).
      [
        'a plain skill that merely mentions permissions',
        'careful',
        [
          '---',
          'name: careful',
          'description: a plain skill with an opinion about permissions',
          "permissions: 'plan'",
          "max-runtime: '30m'",
          '---',
          'Help.',
        ].join('\n'),
      ],
      // A crash-left backup of a schedule skill is a copy for install recovery
      // to settle; rewriting it would change what recovery restores (DOR-2273).
      [
        'a marketplace install sibling (DOR-2273)',
        `hand-written.dorkos-bak-${Date.now()}-9f1c2d3e-0000-4000-8000-000000000000`,
        legacyFile('hand-written', { cron: '0 2 * * *' }),
      ],
    ])('leaves %s alone', async (_case, dirName, content) => {
      await writeAt(h.globalDestination(dirName), content);

      const report = await h.migrate();

      expect(report.foldedInPlace).toBe(0);
      expect(await fs.readFile(h.globalDestination(dirName), 'utf-8')).toBe(content);
    });

    it('never rewrites a package-owned skill reached through a symlink', async () => {
      // Rewriting through the link would edit the package's own checkout:
      // invisible in the app, shared by every agent that installed it, and
      // overwritten by the next update.
      const pluginSkill = path.join(h.dorkHome, 'plugins', 'flow', 'skills', 'drain');
      const owned = legacyFile('drain', { cron: '*/10 * * * *' });
      await writeAt(path.join(pluginSkill, SKILL_FILENAME), owned);
      await fs.mkdir(path.join(h.dorkHome, 'skills'), { recursive: true });
      await fs.symlink(pluginSkill, path.join(h.dorkHome, 'skills', 'flow__drain'));

      await h.migrate();

      expect(await fs.readFile(path.join(pluginSkill, SKILL_FILENAME), 'utf-8')).toBe(owned);
    });
  });
});
