import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import {
  planInstalledCommands,
  planInstalledSkills,
  planOpencodeCommandsGitignore,
  planSkillNameCollisions,
  rewritePluginRootInHooks,
  opencodeWrapperFilename,
} from '../installed-projector.js';
import { getActionContent } from '../content-map.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import type { InstalledPlugin } from '../../sources/installed.js';

/** An empty repo root (no authored skills / AGENTS.md) so only installed projections show. */
function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'harness-oc-'));
}

/** A project-scoped plugin with a rich-frontmatter command, two skills, and a token hook. */
const plugin: InstalledPlugin = {
  name: 'flow',
  type: 'plugin',
  scope: 'project',
  relDir: '.dork/plugins/flow',
  skills: [
    {
      name: 'capturing',
      sourceDir: '.dork/plugins/flow/skills/capturing',
      usesPluginRoot: false,
      frontmatterName: 'capturing-work',
    },
  ],
  commands: [
    {
      name: 'capture',
      sourcePath: '.dork/plugins/flow/commands/capture.md',
      content:
        '---\n' +
        'description: Capture a thought (the /flow CAPTURE stage)\n' +
        'category: flow\n' +
        'allowed-tools: Read, Glob, Skill\n' +
        'argument-hint: "<idea>"\n' +
        '---\n' +
        'Read `${CLAUDE_PLUGIN_ROOT}/skills/capturing/SKILL.md`.\n',
    },
  ],
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/h.mjs"' }] }],
  },
  layers: ['commands', 'skills', 'hooks'],
};

describe('opencodeWrapperFilename', () => {
  it('joins pkg and command with a hyphen (flat, invoked /<pkg>-<name>)', () => {
    // `/flow:capture` in Claude becomes `/flow-capture` in OpenCode (no namespacing).
    expect(opencodeWrapperFilename('flow', 'capture')).toBe('flow-capture.md');
  });
});

describe('planInstalledCommands — opencode', () => {
  it('generates a flat `.opencode/commands/<pkg>-<name>.md` wrapper with the token rewritten, frontmatter reduced to description, and the engine marker', () => {
    const repo = emptyRepo();
    try {
      const actions = planInstalledCommands('opencode', plugin, repo);
      const wrapper = actions.find((a) => a.target === '.opencode/commands/flow-capture.md');
      expect(wrapper).toBeDefined();
      expect(wrapper?.kind).toBe('generate');

      const content = getActionContent(wrapper!)!;
      // Token rewritten to the absolute install dir; no bare token remains.
      expect(content).toContain(join(repo, '.dork/plugins/flow', 'skills/capturing/SKILL.md'));
      expect(content).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      // Frontmatter reduced to ONLY description; Claude-only keys stripped.
      expect(
        content.startsWith('---\ndescription: Capture a thought (the /flow CAPTURE stage)\n---\n')
      ).toBe(true);
      expect(content).not.toContain('allowed-tools');
      expect(content).not.toContain('argument-hint');
      expect(content).not.toContain('category');
      // Engine ownership marker (the sweep predicate) after the frontmatter.
      expect(content).toContain('dorkos:generated-command');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT emit a per-plugin `.gitignore` for opencode (the shared dir gets one aggregated one)', () => {
    const repo = emptyRepo();
    try {
      const actions = planInstalledCommands('opencode', plugin, repo);
      expect(actions.some((a) => a.target?.endsWith('.gitignore'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('planOpencodeCommandsGitignore', () => {
  it('lists every generated wrapper filename plus itself, never a `*` wildcard, and carries the marker', () => {
    const gitignore = planOpencodeCommandsGitignore([plugin]);
    expect(gitignore?.target).toBe('.opencode/commands/.gitignore');
    const content = getActionContent(gitignore!)!;
    expect(content).toContain('flow-capture.md'); // the engine wrapper is ignored
    expect(content).toContain('.gitignore'); // it ignores itself
    expect(content).not.toContain('*'); // NEVER a wildcard — authored commands must stay committable
    expect(content).toContain('dorkos:generated-command'); // marker so the sweep recognizes it
  });

  it('returns undefined when no plugin ships a command', () => {
    expect(planOpencodeCommandsGitignore([{ ...plugin, commands: [] }])).toBeUndefined();
  });
});

describe('planInstalledSkills — opencode', () => {
  it('projects installed skills as `native` (no symlink of its own) since OpenCode reads .agents/skills directly', () => {
    const { actions } = planInstalledSkills('opencode', plugin);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('native');
    expect(actions[0].name).toBe('flow__capturing');
    expect(actions[0].target).toBeUndefined(); // native: no file written
  });

  it('still warns when a projected skill references ${CLAUDE_PLUGIN_ROOT}', () => {
    const { warnings } = planInstalledSkills('opencode', {
      ...plugin,
      skills: [
        {
          name: 'capturing',
          sourceDir: '.dork/plugins/flow/skills/capturing',
          usesPluginRoot: true,
        },
      ],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain('${CLAUDE_PLUGIN_ROOT}');
  });
});

describe('rewritePluginRootInHooks — item A', () => {
  it('rewrites every ${CLAUDE_PLUGIN_ROOT} to the absolute install dir', () => {
    const out = rewritePluginRootInHooks(
      { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/h.mjs"' }] }] },
      '/abs/install'
    );
    expect(out?.Stop[0].hooks[0].command).toBe('node "/abs/install/h.mjs"');
  });

  it('returns undefined for undefined input', () => {
    expect(rewritePluginRootInHooks(undefined, '/abs')).toBeUndefined();
  });
});

describe('buildPlan — opencode harness', () => {
  const manifest = parseHarnessManifest({
    version: 1,
    harnesses: ['claude-code', 'codex', 'opencode'],
  });

  it('projects opencode command wrappers + the aggregated gitignore, skills native, hooks dropped, AGENTS.md native', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest,
        agentsMdExists: true,
        installedPlugins: [plugin],
      });

      // Command wrapper + aggregated gitignore.
      expect(
        plan.actions.some(
          (a) =>
            a.harness === 'opencode' &&
            a.kind === 'generate' &&
            a.target === '.opencode/commands/flow-capture.md'
        )
      ).toBe(true);
      expect(
        plan.actions.some(
          (a) => a.harness === 'opencode' && a.target === '.opencode/commands/.gitignore'
        )
      ).toBe(true);

      // Skills native (no opencode symlink action).
      expect(
        plan.actions.some(
          (a) => a.harness === 'opencode' && a.artifact === 'skill' && a.kind === 'symlink'
        )
      ).toBe(false);
      expect(
        plan.actions.some(
          (a) => a.harness === 'opencode' && a.artifact === 'skill' && a.kind === 'native'
        )
      ).toBe(true);

      // Instructions native.
      expect(
        plan.actions.some(
          (a) => a.harness === 'opencode' && a.artifact === 'instruction' && a.kind === 'native'
        )
      ).toBe(true);

      // Hooks dropped honestly (no declarative hook config).
      const hookDrop = plan.drops.find((d) => d.harness === 'opencode' && d.artifact === 'hook');
      expect(hookDrop?.reason).toMatch(/no declarative hook config/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rewrites the installed hook token to absolute in the generated Codex hooks and emits NO token warning (item A)', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest,
        agentsMdExists: false,
        installedPlugins: [plugin],
      });
      const codexHooks = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.codex/hooks.json'
      );
      const content = getActionContent(codexHooks!)!;
      expect(content).toContain(join(repo, '.dork/plugins/flow', 'h.mjs'));
      expect(content).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(plan.warnings.some((w) => w.harness === 'codex' && w.artifact === 'hook')).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still warns for an AUTHORED hook token whose install root is unknown (item A)', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest,
        claudeHooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/x.mjs"' }] }],
        },
        agentsMdExists: false,
        installedPlugins: [],
      });
      expect(
        plan.warnings.some(
          (w) =>
            w.harness === 'codex' &&
            w.artifact === 'hook' &&
            w.reason.includes('${CLAUDE_PLUGIN_ROOT}')
        )
      ).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('planSkillNameCollisions — item C', () => {
  const skill = (name: string, frontmatterName?: string) => ({
    name,
    sourceDir: `.dork/plugins/x/skills/${name}`,
    usesPluginRoot: false,
    frontmatterName,
  });
  const pluginWith = (pkg: string, frontmatterName: string): InstalledPlugin => ({
    name: pkg,
    type: 'plugin',
    scope: 'project',
    relDir: `.dork/plugins/${pkg}`,
    skills: [skill('s', frontmatterName)],
    commands: [],
    layers: ['skills'],
  });

  it('fires for two installed plugins sharing a frontmatter name, per frontmatter-keyed enabled harness', () => {
    const warnings = planSkillNameCollisions({
      authoredSkillNames: [],
      plugins: [pluginWith('flow', 'capturing-work'), pluginWith('other', 'capturing-work')],
      harnesses: ['claude-code', 'codex', 'opencode'],
    });
    // 2 colliding installed skills x 2 frontmatter-keyed harnesses (codex, opencode) = 4.
    expect(warnings).toHaveLength(4);
    expect(warnings.every((w) => w.reason.includes('capturing-work'))).toBe(true);
    expect(warnings.some((w) => w.harness === 'codex')).toBe(true);
    expect(warnings.some((w) => w.harness === 'opencode')).toBe(true);
    expect(warnings.some((w) => w.harness === 'claude-code')).toBe(false); // dir-keyed, protected
  });

  it('fires when an installed frontmatter name collides with an authored skill name', () => {
    const warnings = planSkillNameCollisions({
      authoredSkillNames: ['capturing-work'],
      plugins: [pluginWith('flow', 'capturing-work')],
      harnesses: ['opencode'],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].name).toBe('flow__s');
    expect(warnings[0].reason).toContain('authored skill "capturing-work"');
  });

  it('does NOT false-positive when frontmatter names differ', () => {
    const warnings = planSkillNameCollisions({
      authoredSkillNames: ['something-else'],
      plugins: [pluginWith('flow', 'capturing-work'), pluginWith('other', 'reviewing-work')],
      harnesses: ['codex', 'opencode'],
    });
    expect(warnings).toEqual([]);
  });

  it('emits nothing when no frontmatter-keyed harness is enabled, even on a real collision', () => {
    const warnings = planSkillNameCollisions({
      authoredSkillNames: ['capturing-work'],
      plugins: [pluginWith('flow', 'capturing-work')],
      harnesses: ['claude-code', 'cursor'],
    });
    expect(warnings).toEqual([]);
  });

  it('falls back to the directory name when a skill declares no frontmatter name', () => {
    // Two plugins each shipping a dir-named `s` with no frontmatter name collide on `s`.
    const warnings = planSkillNameCollisions({
      authoredSkillNames: [],
      plugins: [
        pluginWith('flow', undefined as unknown as string),
        pluginWith('other', undefined as unknown as string),
      ],
      harnesses: ['opencode'],
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].reason).toContain('"s"');
  });
});
