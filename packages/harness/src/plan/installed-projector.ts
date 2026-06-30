/**
 * Installed-plugin projection — turn a {@link InstalledPlugin} into projection
 * actions for one harness, plus the honest drops for everything that has no
 * harness home.
 *
 * Portable assets: skills + tasks (both `SKILL.md` directories) project as skill
 * symlinks, always namespaced `<pkg>__<name>` so an installed skill can never
 * silently overwrite an authored one. Hooks are merged into the generated Codex
 * hooks file by the projector (see {@link mergeHookConfigs}); they are not
 * emitted here. Non-portable layers (extensions, adapters, mcp-servers, …) are
 * dropped with a reason. Claude needs no projection at all — it activates the
 * whole installed plugin through the SDK plugins array.
 *
 * @module plan/installed-projector
 */
import type { HarnessId } from '../manifest/schema.js';
import type { ProjectionAction } from './types.js';
import type { InstalledPlugin } from '../sources/installed.js';
import type { ClaudeHooksConfig } from '../generate/hooks.js';

/**
 * The Codex skills directory. Codex reads `.agents/skills/<name>` directly, so an
 * installed plugin's skills are symlinked there under their namespaced name.
 */
const CODEX_SKILLS_DIR = '.agents/skills';

/** Manifest layers with no harness home — each dropped with the given reason. */
const NON_PORTABLE_LAYER_REASONS: Record<string, string> = {
  commands: 'no repo-local slash-command format; behavior travels as a mapped skill',
  extensions: 'UI extensions run inside DorkOS, not in a harness',
  adapters: 'messaging adapters run inside DorkOS, not in a harness',
  'mcp-servers': 'MCP servers are configured per-harness, not projected as files',
  'lsp-servers': 'LSP servers are configured per-harness, not projected as files',
  agents: 'agent definitions are installed as workspaces, not harness assets',
};

/** The harness a plugin-level (harness-agnostic) drop is attributed to for display. */
const DROP_ATTRIBUTION: HarnessId = 'codex';

/** Project one installed plugin's skills + tasks to a single harness. */
export function planInstalledSkills(
  harness: HarnessId,
  plugin: InstalledPlugin
): ProjectionAction[] {
  switch (harness) {
    case 'claude-code':
      // Claude activates the whole installed plugin via the SDK plugins array —
      // no per-skill filesystem projection is needed or wanted.
      return [
        {
          kind: 'native',
          artifact: 'plugin',
          harness,
          provenance: 'installed',
          name: plugin.name,
          reason: 'Claude activates installed plugins via the SDK plugins array',
        },
      ];
    case 'codex':
      return plugin.skills.map((skill) => {
        const namespaced = `${plugin.name}__${skill.name}`;
        return {
          kind: 'symlink',
          artifact: 'skill',
          harness,
          provenance: 'installed',
          name: namespaced,
          source: skill.sourceDir,
          target: `${CODEX_SKILLS_DIR}/${namespaced}`,
        };
      });
    default:
      return [
        {
          kind: 'drop',
          artifact: 'plugin',
          harness,
          provenance: 'installed',
          name: plugin.name,
          reason: `installed-plugin skills are not auto-projected to ${harness} in v1; see DOR-143`,
        },
      ];
  }
}

/** Drop a project plugin's non-portable layers, one drop per layer (with reasons). */
export function dropNonPortableLayers(plugin: InstalledPlugin): ProjectionAction[] {
  return plugin.layers
    .filter((layer) => layer in NON_PORTABLE_LAYER_REASONS)
    .map((layer) => ({
      kind: 'drop' as const,
      artifact: 'plugin' as const,
      harness: DROP_ATTRIBUTION,
      provenance: 'installed' as const,
      name: `${plugin.name}:${layer}`,
      reason: `plugin layer "${layer}" is not a portable harness asset — ${NON_PORTABLE_LAYER_REASONS[layer]}`,
    }));
}

/** Drop a whole plugin (one action) with the given reason — for global or unsupported-type plugins. */
export function dropWholePlugin(plugin: InstalledPlugin, reason: string): ProjectionAction {
  return {
    kind: 'drop',
    artifact: 'plugin',
    harness: DROP_ATTRIBUTION,
    provenance: 'installed',
    name: plugin.name,
    reason,
  };
}

/**
 * Merge several Claude-format hooks configs into one, concatenating the matcher
 * groups for each event. Used to fold installed-plugin hooks into the authored
 * hooks before generating the single Codex hooks file. Order is preserved.
 *
 * @param configs - hooks configs to merge (undefined entries are ignored).
 * @returns the merged hooks config (empty when no input has hooks).
 */
export function mergeHookConfigs(
  configs: ReadonlyArray<ClaudeHooksConfig | undefined>
): ClaudeHooksConfig {
  const merged: ClaudeHooksConfig = {};
  for (const config of configs) {
    if (!config) continue;
    for (const [event, groups] of Object.entries(config)) {
      merged[event] = [...(merged[event] ?? []), ...groups];
    }
  }
  return merged;
}
