import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { OPERATING_SKILLS_PACK } from '../pack.js';

describe('OPERATING_SKILLS_PACK', () => {
  it('ships the five canonical skills, umbrella first', () => {
    expect(OPERATING_SKILLS_PACK.map((s) => s.name)).toEqual([
      'operating-dorkos',
      'managing-agents',
      'scheduling-tasks',
      'using-the-marketplace',
      'reading-activity',
    ]);
  });

  it('has unique kebab-case names', () => {
    const names = OPERATING_SKILLS_PACK.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });

  for (const skill of OPERATING_SKILLS_PACK) {
    describe(skill.name, () => {
      // Each skill must serialize to a SKILL.md that the @dorkos/skills parser
      // accepts, with the frontmatter name matching its directory.
      const filePath = `/tmp/.agents/skills/${skill.name}/SKILL.md`;
      const content = matter.stringify(skill.body, {
        name: skill.name,
        description: skill.description,
      });

      it('validates against the @dorkos/skills schema', () => {
        const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
        expect(parsed.ok).toBe(true);
      });

      it('has a discovery description within the 1024-char limit', () => {
        expect(skill.description.length).toBeGreaterThan(0);
        expect(skill.description.length).toBeLessThanOrEqual(1024);
      });

      it('body is at most 150 lines', () => {
        expect(skill.body.split('\n').length).toBeLessThanOrEqual(150);
      });
    });
  }
});
