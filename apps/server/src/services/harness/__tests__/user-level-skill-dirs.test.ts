/**
 * Which of the person's user-level skill folders DorkOS reads names from, so no
 * package skill replaces one on OpenCode (DOR-4392, Security's U1, U2 and G1 on
 * #3752).
 *
 * `$HOME` is pinned at a temp folder for every case (`os.homedir()` answers
 * `$HOME` first), so nothing here reads the real home folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byNameUserSkillDirs } from '../agents-user-home.js';
import { projectUserSkills, resolveGlobalScopeInputs } from '../global-scope.js';
import { AGENT_WORKSPACE_HARNESSES } from '../project-agent-workspace.js';
import { renderSkippedSkillLines } from '../../runtimes/opencode/messaging/skipped-skills.js';

const roots: string[] = [];
let home: string;
let dorkHome: string;

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function skillAt(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
}

/** A `config.json` sharing all-projects packages with `harnesses`. */
function shareWith(harnesses: string[]): void {
  writeFileSync(
    join(dorkHome, 'config.json'),
    JSON.stringify({ harness: { global: { harnesses, askedAt: '2026-11-15T00:00:00.000Z' } } })
  );
}

const NO_BOUNDARY = { getDot: () => undefined };

beforeEach(() => {
  home = temp('dor4392-home-');
  dorkHome = temp('dor4392-dork-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', '');
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('DORKOS_BOUNDARY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the user-level skill folders OpenCode reads', () => {
  it("are OpenCode's three, from the vendor table", () => {
    expect(byNameUserSkillDirs()).toEqual([
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.claude', 'skills'),
      join(home, '.agents', 'skills'),
    ]);
  });

  it('follow $XDG_CONFIG_HOME for the OpenCode folder, as OpenCode does', () => {
    const xdg = temp('dor4392-xdg-');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    expect(byNameUserSkillDirs()[0]).toBe(join(xdg, 'opencode', 'skills'));
  });

  it('are not read at all under a configured boundary', () => {
    expect(projectUserSkills(dorkHome, { DORKOS_BOUNDARY: '/somewhere' }).dirs).toEqual([]);
    expect(projectUserSkills(dorkHome, {})).toEqual({ dirs: byNameUserSkillDirs(), dorkHome });
  });
});

describe('the global plan reads them only when it shares with an agent tool', () => {
  it('adds them beside a user tier', () => {
    shareWith(['opencode']);
    const { roots: planRoots } = resolveGlobalScopeInputs(dorkHome, {}, NO_BOUNDARY);
    expect(planRoots.ownSkillDirs).toEqual(byNameUserSkillDirs());
  });

  it('leaves them out when nothing is shared, or under a boundary', () => {
    shareWith([]);
    expect(resolveGlobalScopeInputs(dorkHome, {}, NO_BOUNDARY).roots.ownSkillDirs).toBeUndefined();
    shareWith(['opencode']);
    expect(
      resolveGlobalScopeInputs(dorkHome, { DORKOS_BOUNDARY: '/somewhere' }, NO_BOUNDARY).roots
        .ownSkillDirs
    ).toBeUndefined();
  });
});

describe('an OpenCode agent is told a package skill was left out for a user-level skill (U1)', () => {
  it("names the person's ~/.claude/skills skill as the one it has", () => {
    skillAt(join(home, '.claude', 'skills', 'my-deploy'), 'deploy');
    const agent = temp('dor4392-agent-');
    mkdirSync(join(agent, '.agents'), { recursive: true });
    writeFileSync(
      join(agent, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: AGENT_WORKSPACE_HARNESSES })
    );
    const pkg = join(agent, '.dork', 'plugins', 'acme');
    mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme' }));
    skillAt(join(pkg, 'skills', 'ship'), 'deploy');

    expect(renderSkippedSkillLines(agent)).toContain(
      `the person's own skill at ${join(home, '.claude', 'skills', 'my-deploy')} has this name`
    );
  });
});
