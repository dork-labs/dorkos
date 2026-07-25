import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION } from '../pack.js';

/** The pack as one searchable blob: descriptions and bodies together. */
const ALL_TEXT = OPERATING_SKILLS_PACK.map((s) => `${s.description}\n${s.body}`).join('\n');

/** One skill's body by name, for assertions scoped to a single skill. */
function bodyOf(name: string): string {
  const skill = OPERATING_SKILLS_PACK.find((s) => s.name === name);
  if (!skill) throw new Error(`No such skill in the pack: ${name}`);
  return skill.body;
}

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

      it('uses no em-dashes (repo-wide ban, and this is model-facing prose)', () => {
        expect(skill.description).not.toContain('—');
        expect(skill.body).not.toContain('—');
      });
    });
  }
});

/**
 * Content assertions, not style ones: each of these pins a field name or a flag
 * that a wrong value would turn into a silent failure with the agent reporting
 * success. Pack v2 shipped exactly that bug for `marketplace_uninstall` and for
 * `config_patch`, which is why these are asserted rather than trusted.
 */
describe('the pack teaches the world as it actually is', () => {
  it('is stamped at a version at least 3 (tiers + approvals + dorkos call)', () => {
    expect(OPERATING_SKILLS_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('teaches the three permission tiers', () => {
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('observe');
    expect(umbrella).toContain('act');
    expect(umbrella).toContain('destructive');
  });

  it('teaches the approval_required payload and the approvalToken retry', () => {
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('approval_required');
    expect(umbrella).toContain('approvalToken');
    expect(umbrella).toContain('--approval');
    // The reasons a model has to branch on, not just the happy path.
    expect(umbrella).toContain('awaiting_decision');
    expect(umbrella).toContain('tier_ceiling');
    expect(umbrella).toContain('operator_denied');
  });

  it('teaches `dorkos call`, the only actuation path a Codex/OpenCode agent has', () => {
    expect(ALL_TEXT).toContain('dorkos call');
    expect(bodyOf('operating-dorkos')).toContain("dorkos call <capability-id> [--input '<json>']");
  });

  it('says the capability catalog is not the whole tool list', () => {
    // The defect this pack round exists to stop repeating: an agent told the
    // catalog is everything concludes it cannot manage tasks or message a peer.
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('The catalog covers capabilities only');
    expect(umbrella).toContain('cannot reach them');
  });

  it('routes marketplace_uninstall through the approval flow, not requires_confirmation', () => {
    const marketplace = bodyOf('using-the-marketplace');
    const uninstallSection = marketplace.slice(marketplace.indexOf('## Remove a package'));
    expect(uninstallSection).toContain('approval_required');
    expect(uninstallSection).toContain('approvalToken');
    expect(uninstallSection).not.toContain('requires_confirmation');
  });

  it('keeps the requires_confirmation handshake only where it is still real', () => {
    // `marketplace_install` and `marketplace_create_package` are `act` tier and do
    // still run the older confirmation-token dance; only uninstall moved.
    const marketplace = bodyOf('using-the-marketplace');
    expect(marketplace).toContain('requires_confirmation');
    expect(marketplace).toContain('confirmationToken');
  });

  it('sends config_patch its required `patch` wrapper', () => {
    expect(bodyOf('operating-dorkos')).toContain('config_patch({ "patch"');
  });

  it('describes ui.statusBar as a pins list, not per-item booleans', () => {
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('ui.statusBar.pins');
    expect(umbrella).not.toContain('"statusBar": { "git": false }');
  });
});
