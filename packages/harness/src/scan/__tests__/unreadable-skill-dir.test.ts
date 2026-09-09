/**
 * A skill DIRECTORY nobody can read — kept, named, and never swept (SK-03,
 * AP-07, DOR-1935).
 *
 * `listSkillDirs` decided whether an entry was a skill by asking whether
 * `<entry>/SKILL.md` exists, and `existsSync` needs `x` on the directory. So a
 * skill folder that lost its permissions — or one being removed by an `rm -rf`
 * that is still running — answered "not a skill" and was dropped from the
 * listing in silence. The package around it was still enumerated perfectly well,
 * which is what made it dangerous: under the sweep rule DOR-1923 shipped, a
 * `<pkg>__<name>` link whose package the plan enumerated and whose target the
 * plan does not name is an orphan, so the link went too, with nothing printed.
 * Measured during DOR-1923's review, case (g).
 *
 * This is the same argument DOR-1882 made one level up, one level down: a
 * listing is evidence only about the entries it could read. An unreadable
 * `SKILL.md` FILE was already safe (`toInstalledSkill` records it as empty) and
 * an unreadable `skills/` ROOT was already safe (`unreadableSkillRoots`); the
 * directory between them was the hole.
 *
 * @module scan/__tests__/unreadable-skill-dir
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkillDirs, scanSkillDirs } from '../scanner.js';

/** Whether this platform can stage an unreadable directory: not Windows, not root. */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

const staged: string[] = [];
const chmodded: string[] = [];

afterEach(() => {
  for (const abs of chmodded.splice(0)) {
    try {
      chmodSync(abs, 0o755);
    } catch {
      /* already gone */
    }
  }
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skills root holding `greet` and `wave`, with `greet` made unreadable. */
function stageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-skilldir-'));
  staged.push(root);
  for (const name of ['greet', 'wave']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  }
  return root;
}

describe('SK-03 — a skill directory that cannot be read', () => {
  it.skipIf(!CAN_MAKE_UNREADABLE)('SK-03: stays in the listing, flagged, and is named', () => {
    const root = stageRoot();
    chmodSync(join(root, 'greet'), 0o000);
    chmodded.push(join(root, 'greet'));

    const listing = listSkillDirs(root, 'skills');

    expect(listing.skills.map((s) => s.name)).toEqual(['greet', 'wave']);
    expect(listing.skills.find((s) => s.name === 'greet')?.unreadable).toBe(true);
    expect(listing.skills.find((s) => s.name === 'wave')?.unreadable).toBeUndefined();
    expect(listing.unreadableSkills).toEqual(['skills/greet']);
    // The ROOT read fine. Confusing the two would stand both skill sweeps down
    // over one bad folder inside it.
    expect(listing.unreadable).toBe(false);
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'SK-03: the narrow reader still shows only what it can see',
    () => {
      // The split this scanner already documents: a PLANNER keeps an unreadable
      // entry because the plan is the sweeps' keep-set, and a list somebody READS
      // drops it because there is nothing to show. Seeded defect: return
      // `listSkillDirs().skills` unfiltered, and the source inventory starts
      // offering a folder it cannot open as an adoptable skill.
      const root = stageRoot();
      chmodSync(join(root, 'greet'), 0o000);
      chmodded.push(join(root, 'greet'));

      expect(scanSkillDirs(root, 'skills').map((s) => s.name)).toEqual(['wave']);
    }
  );

  it('SK-03: a directory with no SKILL.md in it is still not a skill', () => {
    // The floor under the case above: "could not look" must not become "count
    // everything". Seeded defect: treat every non-skill directory as unreadable.
    const root = stageRoot();
    mkdirSync(join(root, 'notaskill'), { recursive: true });

    const listing = listSkillDirs(root, 'skills');

    expect(listing.skills.map((s) => s.name)).toEqual(['greet', 'wave']);
    expect(listing.unreadableSkills).toEqual([]);
  });
});
