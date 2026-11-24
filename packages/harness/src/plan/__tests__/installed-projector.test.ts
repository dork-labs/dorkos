import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { mergeHookConfigs, pluginRootText, projectedHooks } from '../installed-projector.js';
import { getActionContent } from '../content-map.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import type { InstalledPlugin } from '../../sources/installed.js';
import { MANIFEST, emptyRepo, projectPlugin } from './installed-projector.fixtures.js';

describe('installed-plugin projection via buildPlan', () => {
  it('SK-02: symlinks installed skills into both the Claude Code and Codex skill dirs (namespaced)', () => {
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
      // Nothing about the PLUGIN is native — it reaches Claude Code and Codex as
      // projected files, never as an SDK activation. (Cursor takes the SKILLS
      // native off the `.agents/skills` link, which is the row above; the check
      // is scoped to the plugin-level artifact so it still means what it says.)
      expect(
        plan.actions.some(
          (a) => a.provenance === 'installed' && a.kind === 'native' && a.artifact === 'plugin'
        )
      ).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('CM-01: generates repo-local command wrappers for Claude Code with the token rewritten to absolute', () => {
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
      // The install root is spelled with FORWARD SLASHES inside generated text on
      // every platform (`pluginRootText`, whose own test covers both branches):
      // `join()` would spell it with backslashes on Windows and leave the rest of
      // the line, which the plugin wrote, with forward ones.
      expect(content).toContain(
        `${pluginRootText(join(repo, '.dork/plugins/acme'), process.platform)}/skills/x/SKILL.md`
      );
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

  it('HK-06: merges installed-plugin hooks into .claude/settings.local.json for Claude Code', () => {
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

  it('SK-02: namespaces installed skills so they never collide with an authored skill of the same name', () => {
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
                hasSchedule: false,
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

  it('SK-05: drops non-portable layers with reasons, and no longer drops a harness that reads .agents/skills', () => {
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
      // Cursor used to get one whole-plugin drop ("not auto-projected to cursor
      // in v1; see DOR-143"). It reads `.agents/skills` natively, and the link
      // there is now planned whatever harnesses are enabled, so the honest answer
      // is a per-skill `native` and no drop at all (SK-05).
      expect(
        plan.drops.filter(
          (d) => d.provenance === 'installed' && d.harness === 'cursor' && d.name === 'acme'
        )
      ).toEqual([]);
      expect(
        plan.actions
          .filter(
            (a) => a.provenance === 'installed' && a.harness === 'cursor' && a.artifact === 'skill'
          )
          .map((a) => ({ kind: a.kind, name: a.name }))
      ).toEqual([
        { kind: 'native', name: 'acme__alpha' },
        { kind: 'native', name: 'acme__beta' },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('SRC-04, AP-12: scope mapping: a global install is dropped, never projected into project dirs', () => {
    const repo = emptyRepo();
    try {
      const globalPlugin: InstalledPlugin = {
        name: 'globex',
        type: 'plugin',
        location: { scope: 'global', absDir: '/home/dork/.dork/plugins/globex' },
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
      // The reason's two forms are pinned in `global-install-drop.test.ts`; here
      // it only has to be the global-install line rather than a projection.
      expect(globalDrop?.reason).toMatch(/^installed for all your projects\./);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('CM-06: names each harness’s own command format on an installed-command drop', () => {
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
      // Codex is the one harness with genuinely no repo-local command format:
      // its custom prompts were deprecated in favour of skills. The other
      // harnesses' drops now name their own format instead (CM-06).
      expect(drop?.reason).toMatch(/no repo-local slash-command format/);
      // Cursor is in this manifest too, and gets the honest reason — asserted
      // here rather than left to the authored half, because the installed drop
      // is a separate call site that shared the same stale sentence.
      const cursorDrop = plan.drops.find(
        (d) => d.provenance === 'installed' && d.artifact === 'command' && d.harness === 'cursor'
      );
      expect(cursorDrop?.reason).toContain('.cursor/commands/*.md');
      expect(cursorDrop?.reason).not.toMatch(/no repo-local slash-command format/);
      // The `commands` layer is NOT reported as a non-portable-layer drop anymore.
      // `reason` is optional on ProjectionAction (required only by convention for
      // drops), so it is narrowed rather than asserted — an absent reason cannot
      // mention a layer either, so the `false` expectation is unchanged.
      expect(
        plan.drops.some((d) => d.name === 'acme:commands' && d.reason?.includes('layer'))
      ).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('mergeHookConfigs', () => {
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

describe('projectedHooks', () => {
  it('VC-04: reports each command with the event and matcher that fire it, plugin root resolved', () => {
    const plugin: InstalledPlugin = {
      ...projectPlugin,
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo two' }] }],
      },
    };
    expect(projectedHooks([plugin], '/repo')).toEqual([
      {
        packageName: 'acme',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash', command: 'echo two' },
          { event: 'Stop', command: 'node "/repo/.dork/plugins/acme/hooks/x.mjs"' },
        ],
      },
    ]);
  });
});

describe('installed plugin skills reach the watched skills root (DOR-1518, DOR-1847)', () => {
  /** The manifest a stock project has: Claude Code only, which never sees `.agents/skills`. */
  const CLAUDE_ONLY = parseHarnessManifest({ version: 1, harnesses: ['claude-code'] });

  /** A plugin shipping one scheduled skill and one ordinary one (the flow plugin's shape). */
  const withScheduledSkill: InstalledPlugin = {
    ...projectPlugin,
    commands: [],
    skills: [
      {
        name: 'drain',
        sourceDir: '.dork/plugins/acme/skills/drain',
        usesPluginRoot: false,
        hasSchedule: true,
      },
      {
        name: 'alpha',
        sourceDir: '.dork/plugins/acme/skills/alpha',
        usesPluginRoot: false,
        hasSchedule: false,
      },
    ],
  };

  it('SK-03: links a scheduled skill into .agents/skills even when only claude-code is enabled', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: CLAUDE_ONLY,
        agentsMdExists: false,
        installedPlugins: [withScheduledSkill],
      });

      const link = plan.actions.find((a) => a.target === '.agents/skills/acme__drain');
      expect(link).toBeDefined();
      expect(link?.kind).toBe('symlink');
      expect(link?.source).toBe('.dork/plugins/acme/skills/drain');
      expect(link?.provenance).toBe('installed');
      // The note that explains why a link exists in a directory no enabled
      // harness reads. That it REACHES the operator is pinned separately, on the
      // CLI report itself (`packages/cli/src/__tests__/harness-sync.test.ts`).
      expect(link?.reason).toContain('scheduler');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('SK-07: warns about an unresolved plugin-root token in a scheduled skill it links', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: CLAUDE_ONLY,
        agentsMdExists: false,
        installedPlugins: [
          {
            ...withScheduledSkill,
            skills: [
              {
                name: 'drain',
                sourceDir: '.dork/plugins/acme/skills/drain',
                usesPluginRoot: true,
                hasSchedule: true,
              },
            ],
          },
        ],
      });

      const warned = plan.warnings.filter(
        (w) => w.name === 'acme__drain' && w.reason.includes('${CLAUDE_PLUGIN_ROOT}')
      );
      // One for the Claude Code projection, one for the scheduler link.
      expect(warned).toHaveLength(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('installed skills reach .agents/skills whatever harnesses are enabled (SK-05)', () => {
  /** Every planned symlink target for installed content, in plan order. */
  function installedLinks(plan: ReturnType<typeof buildPlan>): string[] {
    return plan.actions
      .filter((a) => a.provenance === 'installed' && a.kind === 'symlink')
      .map((a) => a.target as string);
  }

  /** Plan `projectPlugin` against one harness set. */
  function planFor(harnesses: string[]): ReturnType<typeof buildPlan> {
    const repo = emptyRepo();
    try {
      return buildPlan({
        repoRoot: repo,
        manifest: parseHarnessManifest({ version: 1, harnesses }),
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  it('SK-05: links them for an opencode-only project, and says so on the native action', () => {
    // Reproduced 2026-09-07: with `harnesses: ['opencode']` the plan claimed
    // `native` "via the Codex namespaced symlink" while nothing linked the
    // directory at all, so the skills reached nobody.
    const plan = planFor(['opencode']);

    expect(installedLinks(plan)).toEqual([
      '.agents/skills/acme__alpha',
      '.agents/skills/acme__beta',
    ]);
    const natives = plan.actions.filter(
      (a) => a.provenance === 'installed' && a.harness === 'opencode' && a.artifact === 'skill'
    );
    expect(natives).toHaveLength(2);
    for (const action of natives) {
      expect(action.kind).toBe('native');
      expect(action.reason).toContain(`.agents/skills/${action.name}`);
    }
  });
});
