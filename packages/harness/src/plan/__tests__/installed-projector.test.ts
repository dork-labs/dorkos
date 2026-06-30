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
    { name: 'alpha', sourceDir: '.dork/plugins/acme/skills/alpha' },
    { name: 'beta', sourceDir: '.dork/plugins/acme/.dork/tasks/beta' },
  ],
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-plugin' }] }] },
  layers: ['skills', 'tasks', 'hooks', 'extensions', 'mcp-servers'],
};

describe('installed-plugin projection via buildPlan', () => {
  it('projects skills + tasks to Codex (namespaced, provenance=installed), native to Claude', () => {
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
      // Sources point back into the installed plugin (the task SKILL.md included).
      expect(codexSkills.map((a) => a.source)).toEqual([
        '.dork/plugins/acme/skills/alpha',
        '.dork/plugins/acme/.dork/tasks/beta',
      ]);

      // Claude needs no filesystem projection — the whole plugin activates via the SDK.
      const claudeNative = plan.actions.find(
        (a) => a.provenance === 'installed' && a.harness === 'claude-code'
      );
      expect(claudeNative?.kind).toBe('native');
      expect(claudeNative?.artifact).toBe('plugin');
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
            skills: [{ name: 'alpha', sourceDir: '.dork/plugins/acme/skills/alpha' }],
          },
        ],
      });
      const target = plan.actions.find(
        (a) => a.provenance === 'installed' && a.kind === 'symlink'
      )?.target;
      // Installed `alpha` is `acme__alpha` — distinct from an authored `.claude/skills/alpha`.
      expect(target).toBe('.agents/skills/acme__alpha');
      expect(target).not.toBe('.agents/skills/alpha');
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
      // extensions + mcp-servers are non-portable; skills/tasks/hooks are NOT dropped.
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
