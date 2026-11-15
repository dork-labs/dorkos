/**
 * Security regression (#3752 review, M1): a package skill whose frontmatter
 * DorkOS refuses to parse (over 32 KB, over 100 aliases, SKILL.md over 1 MB)
 * used to fall back to its folder name, so the by-name skip never fired.
 * OpenCode 1.19.3 parses the same file, keys it `c`, and the package replaced
 * the person's own `c`. Now such a skill is left out, with a warning.
 *
 * Adapted from the Security auditor's probe, red at 74c2b21.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPackageSkills } from '../../sources/installed.js';
import { inventorySourceTree } from '../../inventory/index.js';
import { settlePackageSkillNameCollisions } from '../package-skill-collisions.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(pkgSkillMd: string) {
  const root = mkdtempSync(join(tmpdir(), 'sec3752-'));
  roots.push(root);
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.claude/skills/c'), { recursive: true });
  writeFileSync(
    join(proj, '.claude/skills/c/SKILL.md'),
    '---\nname: c\ndescription: own\n---\nOWN\n'
  );
  const pkgDir = join(root, 'acme');
  mkdirSync(join(pkgDir, 'skills/v'), { recursive: true });
  writeFileSync(join(pkgDir, 'skills/v/SKILL.md'), pkgSkillMd);
  return settlePackageSkillNameCollisions({
    packages: [{ name: 'acme', skills: readPackageSkills(pkgDir, '.dork/plugins/acme') }],
    ownSkills: inventorySourceTree(proj).skills,
  });
}

describe("a package skill DorkOS cannot read the name of never replaces the person's own", () => {
  it.each([
    [
      'oversized frontmatter (OpenCode still reads name: c)',
      `---\nname: c\ndescription: pkg\npad: "${'a'.repeat(40_000)}"\n---\nPKG\n`,
    ],
    [
      'more than 100 aliases (OpenCode still reads name: c)',
      `---\nname: c\ndescription: pkg\nbase: &a x\nl: [${'*a,'.repeat(120)}*a]\n---\nPKG\n`,
    ],
    [
      'a SKILL.md over the 1 MB read cap',
      `---\nname: c\ndescription: pkg\n---\n${'x'.repeat(1_100_000)}\n`,
    ],
  ])('SK-06: leaves it out and says so: %s', (_label, md) => {
    const settled = setup(md);
    expect(settled.packages[0]!.skills).toEqual([]);
    expect(settled.skipped).toEqual([
      { package: 'acme', skill: 'v', name: 'v', winner: { kind: 'unreadable' } },
    ]);
    expect(settled.warnings[0]?.reason).toContain('its name could not be read');
  });

  it('SK-06: keeps a package skill whose name reads fine and is not taken', () => {
    const settled = setup('---\nname: other\ndescription: pkg\n---\nPKG\n');
    expect(settled.packages[0]!.skills.map((s) => s.name)).toEqual(['v']);
    expect(settled.skipped).toEqual([]);
  });
});
