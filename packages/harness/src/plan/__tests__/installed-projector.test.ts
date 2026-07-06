import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { mergeHookConfigs } from '../installed-projector.js';
import { getActionContent } from '../content-map.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import type { InstalledPlugin } from '../../sources/installed.js';

const MANIFEST = parseHarnessManifest({
  version: 1,
  harnesses: ['claude-code', 'codex', 'cursor'],
});

/** An empty repo root (no authored skills / AGENTS.md) so only installed projections show. */
function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'harness-instproj-'));
}

const projectPlugin: InstalledPlugin = {
  name: 'acme',
  type: 'plugin',
  scope: 'project',
  relDir: '.dork/plugins/acme',
  skills: [
    { name: 'alpha', sourceDir: '.dork/plugins/acme/skills/alpha', usesPluginRoot: false },
    { name: 'beta', sourceDir: '.dork/plugins/acme/.dork/tasks/beta', usesPluginRoot: false },
  ],
  commands: [
    {
      name: 'capture',
      sourcePath: '.dork/plugins/acme/commands/capture.md',
      content: '---\ndescription: cap\n---\nRead `${CLAUDE_PLUGIN_ROOT}/skills/x/SKILL.md`.\n',
    },
  ],
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-plugin' }] }] },
  layers: ['commands', 'skills', 'tasks', 'hooks', 'extensions', 'mcp-servers'],
};

describe('installed-plugin projection via buildPlan', () => {
  it('symlinks installed skills into both the Claude Code and Codex skill dirs (namespaced)', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });

      const codexSkills = plan.actions.filter(
        (a) => a.provenance === 'installed' && a.harness === 'codex' && a.kind === 'symlink'
      );
      expect(codexSkills.map((a) => a.target)).toEqual([
        '.agents/skills/acme__alpha',
        '.agents/skills/acme__beta',
      ]);
      expect(codexSkills.map((a) => a.source)).toEqual([
        '.dork/plugins/acme/skills/alpha',
        '.dork/plugins/acme/.dork/tasks/beta',
      ]);

      // Claude Code gets its OWN namespaced symlinks now (no SDK activation).
      const claudeSkills = plan.actions.filter(
        (a) => a.provenance === 'installed' && a.harness === 'claude-code' && a.kind === 'symlink'
      );
      expect(claudeSkills.map((a) => a.target)).toEqual([
        '.claude/skills/acme__alpha',
        '.claude/skills/acme__beta',
      ]);
      // No `native` plugin action — the plugin reaches Claude via projected files.
      expect(plan.actions.some((a) => a.provenance === 'installed' && a.kind === 'native')).toBe(
        false
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('generates repo-local command wrappers for Claude Code with the token rewritten to absolute', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });

      const wrapper = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.claude/commands/acme/capture.md'
      );
      expect(wrapper).toBeDefined();
      const content = getActionContent(wrapper!)!;
      // Token rewritten to the absolute install dir; no bare token remains.
      expect(content).toContain(join(repo, '.dork/plugins/acme', 'skills/x/SKILL.md'));
      expect(content).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      // Frontmatter preserved as the first bytes; marker inserted right after it.
      expect(content.startsWith('---\ndescription: cap\n---\n')).toBe(true);
      expect(content).toContain('dorkos:generated-command');

      // A self-ignoring .gitignore is generated beside the wrappers.
      const gitignore = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.claude/commands/acme/.gitignore'
      );
      expect(getActionContent(gitignore!)).toContain('*');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('drops installed commands for a harness with no repo-local command format (codex)', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const drop = plan.drops.find(
        (d) =>
          d.provenance === 'installed' &&
          d.artifact === 'command' &&
          d.harness === 'codex' &&
          d.name === 'acme:commands'
      );
      expect(drop?.reason).toMatch(/repo-local command format/);
      // The `commands` layer is NOT reported as a non-portable-layer drop anymore.
      expect(plan.drops.some((d) => d.name === 'acme:commands' && d.reason.includes('layer'))).toBe(
        false
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('merges installed-plugin hooks into .claude/settings.local.json for Claude Code', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const merge = plan.actions.find(
        (a) => a.kind === 'merge' && a.target === '.claude/settings.local.json'
      );
      expect(merge).toBeDefined();
      expect(merge?.harness).toBe('claude-code');
      expect(getActionContent(merge!)).toContain('echo from-plugin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('warns when a projected installed skill still references ${CLAUDE_PLUGIN_ROOT}', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [
          {
            ...projectPlugin,
            skills: [
              {
                name: 'alpha',
                sourceDir: '.dork/plugins/acme/skills/alpha',
                usesPluginRoot: true,
              },
            ],
          },
        ],
      });
      const warning = plan.warnings.find((w) => w.artifact === 'skill' && w.name === 'acme__alpha');
      expect(warning).toBeDefined();
      expect(warning?.reason).toContain('${CLAUDE_PLUGIN_ROOT}');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('namespaces installed skills so they never collide with an authored skill of the same name', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [
          {
            ...projectPlugin,
            skills: [
              {
                name: 'alpha',
                sourceDir: '.dork/plugins/acme/skills/alpha',
                usesPluginRoot: false,
              },
            ],
          },
        ],
      });
      const claudeTarget = plan.actions.find(
        (a) => a.provenance === 'installed' && a.kind === 'symlink' && a.harness === 'claude-code'
      )?.target;
      // Installed `alpha` is `acme__alpha` — distinct from an authored `.claude/skills/alpha`.
      expect(claudeTarget).toBe('.claude/skills/acme__alpha');
      expect(claudeTarget).not.toBe('.claude/skills/alpha');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('drops non-portable layers with reasons, and the unsupported harness with a reason', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const dropNames = plan.drops.filter((d) => d.provenance === 'installed').map((d) => d.name);
      // extensions + mcp-servers are non-portable; skills/tasks/hooks/commands are NOT layer-dropped.
      expect(dropNames).toContain('acme:extensions');
      expect(dropNames).toContain('acme:mcp-servers');
      expect(dropNames).not.toContain('acme:skills');
      expect(dropNames).not.toContain('acme:hooks');
      // cursor cannot take installed skills in v1 — one whole-plugin drop.
      expect(
        plan.drops.some(
          (d) => d.provenance === 'installed' && d.harness === 'cursor' && d.name === 'acme'
        )
      ).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scope mapping: a global install is dropped, never projected into project dirs', () => {
    const repo = emptyRepo();
    try {
      const globalPlugin: InstalledPlugin = {
        name: 'globex',
        type: 'plugin',
        scope: 'global',
        skills: [],
        commands: [],
        layers: ['skills'],
      };
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [globalPlugin, projectPlugin],
      });

      // The project plugin projects; the global plugin never produces a project-dir action.
      expect(plan.actions.some((a) => a.name.startsWith('globex'))).toBe(false);
      expect(plan.actions.some((a) => a.target?.includes('globex'))).toBe(false);
      const globalDrop = plan.drops.find((d) => d.name === 'globex');
      expect(globalDrop?.reason).toMatch(/global-scope/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('folds installed-plugin hooks into the generated Codex hooks file', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const codexHooks = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.codex/hooks.json'
      );
      expect(codexHooks).toBeDefined();
      expect(getActionContent(codexHooks!)).toContain('echo from-plugin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('mergeHookConfigs', () => {
  it('concatenates matcher groups per event and ignores undefined inputs', () => {
    const merged = mergeHookConfigs([
      { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] },
      undefined,
      {
        Stop: [{ hooks: [{ type: 'command', command: 'b' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'c' }] }],
      },
    ]);
    expect(merged.Stop).toHaveLength(2);
    expect(merged.PreToolUse).toHaveLength(1);
  });

  it('returns an empty config when nothing has hooks', () => {
    expect(mergeHookConfigs([undefined, undefined])).toEqual({});
  });

  it('defensively skips a non-array event value rather than crashing the spread', () => {
    const merged = mergeHookConfigs([
      // A malformed config that slipped past validation: `Bad` is not an array.
      { Bad: { type: 'command' } as unknown as [] },
      { Stop: [{ hooks: [{ type: 'command', command: 'ok' }] }] },
    ]);
    expect(merged).not.toHaveProperty('Bad');
    expect(merged.Stop).toHaveLength(1);
  });
});
