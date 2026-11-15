/**
 * Security #3752 review, M2: every agent home DorkOS scaffolds lists only
 * Claude Code (`AGENT_WORKSPACE_HARNESSES`), yet an agent on OpenCode works in
 * exactly such a folder and reads its `.agents/skills`. The same-name skip must
 * protect it whatever the manifest lists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '@dorkos/harness';
import { AGENT_WORKSPACE_HARNESSES } from '../project-agent-workspace.js';
import { renderSkippedSkillLines } from '../../runtimes/opencode/messaging/skipped-skills.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function skillAt(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
}

/** An agent home as DorkOS scaffolds it, the person's own `deploy`, and an agent-local package shipping `deploy`. */
function agentHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-home-pkg-skill-'));
  roots.push(home);
  mkdirSync(join(home, '.agents'), { recursive: true });
  writeFileSync(
    join(home, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: AGENT_WORKSPACE_HARNESSES })
  );
  skillAt(join(home, '.agents', 'skills', 'deploy'), 'deploy');
  const pkg = join(home, '.dork', 'plugins', 'acme');
  mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme' }));
  skillAt(join(pkg, 'skills', 'ship'), 'deploy');
  return home;
}

describe('an agent home protects an OpenCode agent from a same-name package skill (M2)', () => {
  it('starts from a manifest that does not list OpenCode, so the case is the real one', () => {
    expect(AGENT_WORKSPACE_HARNESSES).not.toContain('opencode');
  });

  it("projects only the person's own deploy, records the skip, and tells the agent", () => {
    const home = agentHome();
    const plan = project(home);

    expect(plan.actions.filter((a) => a.target?.endsWith('/acme__ship'))).toEqual([]);
    expect(plan.skippedPackageSkills).toEqual([
      {
        package: 'acme',
        skill: 'ship',
        name: 'deploy',
        winner: { kind: 'own', source: '.agents/skills/deploy' },
      },
    ]);
    expect(renderSkippedSkillLines(home)).toContain(
      `- "deploy" from the acme package: the person's own skill at .agents/skills/deploy has this name`
    );
  });
});
