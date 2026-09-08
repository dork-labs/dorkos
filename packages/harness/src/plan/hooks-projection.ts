/**
 * Hooks projection — how the one canonical hooks source reaches each harness,
 * and what `manifest.hookPolicies` is allowed to change about that.
 *
 * Split out of `plan/projector.ts` because it is the one artifact kind whose
 * answer differs per harness in three directions at once: the file that gets
 * written (Codex, Cursor and Copilot each wrap the event map differently), the
 * events that survive the translation, and — since DOR-1858 — what the repo's
 * own manifest asked for.
 *
 * @module plan/hooks-projection
 */
import {
  HARNESS_LABELS,
  type HarnessId,
  type HarnessManifest,
  type HookProjection,
} from '../manifest/schema.js';
import type { ActionBase, ProjectionAction, ProjectionWarning } from './types.js';
import { setActionContent } from './content-map.js';
import {
  generateCodexHooks,
  generateCursorHooks,
  generateCopilotHooks,
  CODEX_HOOKS_TARGET,
  CURSOR_HOOKS_TARGET,
  COPILOT_HOOKS_TARGET,
  type ClaudeHooksConfig,
  type HookWarning,
  type DroppedHook,
} from '../generate/hooks.js';
import { hooksFactsFor } from '../vendor-facts/index.js';
import type { InstalledPlugin } from '../sources/installed.js';

/** The one authored hooks file the engine reads — Claude Code's own project settings. */
const CLAUDE_SETTINGS_SOURCE = '.claude/settings.json';

/**
 * The static per-harness recipe for a standalone hooks file the engine
 * generates: where it goes and how to build its content.
 */
interface StandaloneHookSpec {
  /** The repo-relative target path for this harness's generated hooks file. */
  target: string;
  /**
   * Translate the merged Claude hooks into this harness's on-disk content.
   *
   * @returns the deterministic file content (or `undefined` when the harness has
   *   zero mappable events, so the file is not written and any stale one is
   *   pruned by the apply stage), plus the dropped events and warnings.
   */
  generate: (claudeHooks: ClaudeHooksConfig) => {
    content: string | undefined;
    dropped: DroppedHook[];
    warnings: HookWarning[];
  };
}

/**
 * Every harness with its own standalone hooks file. Each entry runs its
 * `generate` function over the merged Claude hooks, serializes the result to the
 * `target` path, and emits its unmapped events as drops. Every one of the three
 * writes a WRAPPED file, not a bare event map: Codex nests the event map under
 * `{ description, hooks }`, Cursor and Copilot under `{ version, hooks }`. So
 * each entry owns its own `generate`, returning already-serializable content
 * plus the dropped/warning lists.
 *
 * The engine does not own these paths by path alone — Codex's and Cursor's own
 * docs tell people to write them by hand. Ownership is decided at apply time by
 * a `.dorkos-generated` sidecar (`apply/generated-ownership.ts`).
 *
 * Gemini is intentionally NOT here: its hooks live inside the SHARED
 * `.gemini/settings.json`, which holds unrelated user settings, so it is handled
 * as an honest drop rather than a standalone generated file (see
 * {@link planHooks}).
 */
const STANDALONE_HOOK_HARNESSES: Partial<Record<HarnessId, StandaloneHookSpec>> = {
  codex: {
    target: CODEX_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { file, dropped, warnings } = generateCodexHooks(claudeHooks);
      const content =
        Object.keys(file.hooks).length > 0 ? JSON.stringify(file, null, 2) + '\n' : undefined;
      return { content, dropped, warnings };
    },
  },
  cursor: {
    target: CURSOR_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { file, dropped, warnings } = generateCursorHooks(claudeHooks);
      const content =
        Object.keys(file.hooks).length > 0 ? JSON.stringify(file, null, 2) + '\n' : undefined;
      return { content, dropped, warnings };
    },
  },
  copilot: {
    target: COPILOT_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { file, dropped, warnings } = generateCopilotHooks(claudeHooks);
      const content =
        Object.keys(file.hooks).length > 0 ? JSON.stringify(file, null, 2) + '\n' : undefined;
      return { content, dropped, warnings };
    },
  },
};

/** Whether a hooks config carries at least one event — an absent one and an empty one are the same nothing. */
function hasHooks(hooks?: ClaudeHooksConfig): boolean {
  return hooks !== undefined && Object.keys(hooks).length > 0;
}

/**
 * Where the hooks in the merged config actually came from.
 *
 * Every line about hooks names a file, drops included: a drop with no source
 * cannot be matched back to the declaration it is about, which is how a hook
 * could be "reported" and still be silent to any check that asks whether each
 * authored source reached every harness (P6). But naming
 * `.claude/settings.json` on every line was the other error — a repository with
 * no settings file at all, whose hooks came entirely from an installed package,
 * was told its `.claude/settings.json` hooks were dropped. So the sources are
 * derived, per file and per event, from the configs that were merged.
 */
export interface HookSources {
  /** Every file that contributed a hook, authored settings first. */
  files: string[];
  /** For each event, the file to name when that event is dropped. */
  byEvent: Map<string, string>;
}

/**
 * Work out which file each merged hook event came from.
 *
 * The authored settings file wins a tie: when a repository and a package declare
 * the same event, the person's own file is the one they can act on.
 *
 * @param authoredHooks - the repo's own `.claude/settings.json` hooks.
 * @param contributors - the installed plugins allowed to contribute hooks.
 * @returns the contributing files and the per-event attribution.
 */
export function collectHookSources(
  authoredHooks: ClaudeHooksConfig | undefined,
  contributors: readonly InstalledPlugin[]
): HookSources {
  const files: string[] = [];
  const byEvent = new Map<string, string>();

  if (authoredHooks && hasHooks(authoredHooks)) {
    files.push(CLAUDE_SETTINGS_SOURCE);
    for (const event of Object.keys(authoredHooks)) byEvent.set(event, CLAUDE_SETTINGS_SOURCE);
  }
  for (const plugin of contributors) {
    const hooks = plugin.hooks;
    if (!hooks || !hasHooks(hooks) || !plugin.relDir) continue;
    const file = `${plugin.relDir}/hooks/hooks.json`;
    files.push(file);
    for (const event of Object.keys(hooks)) if (!byEvent.has(event)) byEvent.set(event, file);
  }
  return { files, byEvent };
}

/**
 * Project hooks to one harness (may yield several actions + warnings).
 *
 * `claudeHooks` is the MERGED config — the repo's own hooks plus every installed
 * package's — because that is what the other harnesses' generated files carry.
 * `authoredHooks` is the repo's own half alone, and it is what decides Claude
 * Code's `native`: Claude reads `.claude/settings.json`, and a package's hooks
 * reach it through the separate `.claude/settings.local.json` merge, never that
 * file.
 *
 * **With no hooks there is no artifact, so no harness gets a line.** Not a
 * `native` for a file that may not exist, and not a `drop` either — a drop says
 * something exists that could not travel, and on a repo with no hooks at all
 * nothing did. Claude Code is measured against its own file and every other
 * harness against the merged set, because a package's hooks fail to reach
 * OpenCode and Gemini exactly as an authored one would.
 *
 * The harnesses with no hook file at all get **one drop per contributing file**,
 * so a person whose hooks came from a package is pointed at the package rather
 * than at a `.claude/settings.json` they never wrote.
 *
 * `policy` is what `manifest.hookPolicies` asks for this harness, when it says
 * anything. Read since DOR-1858; an absent entry keeps every line above exactly
 * as it was, so a manifest without the block changes nothing.
 *
 * **A policy governs what the ENGINE writes, never what a vendor reads.** That
 * is the rule the whole thing rests on. Each harness has exactly one mechanism:
 * Claude Code reads `.claude/settings.json` itself (`native`), Codex, Cursor and
 * Copilot get a file the engine writes (`generate`), OpenCode and Gemini have
 * nowhere to write at all (`none`). A policy naming that harness's own mechanism
 * changes nothing. A `none` or `native` policy on a `generate` harness stops the
 * file being written and drops each source with a reason. A policy asking for a
 * mechanism the harness does not have cannot be granted — Claude Code goes on
 * reading its own settings file whatever a manifest says, and no manifest gives
 * OpenCode a hooks file — so those earn a warning naming the key, never a false
 * line claiming hooks did not arrive where they plainly did.
 */
export function planHooks(
  harness: HarnessId,
  sources: HookSources,
  policy: HookProjection | undefined,
  claudeHooks?: ClaudeHooksConfig,
  authoredHooks?: ClaudeHooksConfig
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const base = (source: string): ActionBase => ({
    artifact: 'hook',
    harness,
    provenance: 'authored',
    name: 'hooks',
    source,
  });
  if (harness === 'claude-code') {
    // The `native` line is a fact about Claude Code, not an engine action, so no
    // policy removes it. What a `none` policy switches off here is the one thing
    // the engine WRITES for Claude Code — the installed-plugin merge into
    // `.claude/settings.local.json` — and that is decided in `buildPlan`, where
    // the merge is planned.
    const actions = hasHooks(authoredHooks)
      ? [{ ...base(CLAUDE_SETTINGS_SOURCE), kind: 'native' as const }]
      : [];
    const warnings =
      hasHooks(claudeHooks) && policy === 'generate'
        ? [impossiblePolicyWarning(harness, policy)]
        : [];
    return { actions, warnings };
  }

  // Nothing to project anywhere: say nothing, rather than telling somebody with
  // no hooks that their hooks were dropped.
  if (!hasHooks(claudeHooks)) return { actions: [], warnings: [] };

  const standalone = STANDALONE_HOOK_HARNESSES[harness];
  if (standalone) {
    // `none` and `native` both say "the engine writes nothing here" — one because
    // the hooks are not wanted, the other because the harness is claimed to read
    // them itself. Neither writes the file; each drop says which was asked for.
    if (policy === 'none' || policy === 'native') {
      const reason = policyDropReason(harness, policy, standalone.target);
      return {
        actions: sources.files.map((source) => ({
          ...base(source),
          kind: 'drop' as const,
          reason,
        })),
        warnings: [],
      };
    }
    return planStandaloneHooks(harness, standalone, sources, claudeHooks);
  }

  // OpenCode has NO declarative hook config — only a code-based TypeScript
  // plugin API — so there is no on-disk hook file to project into. Gemini's live
  // inside the shared `.gemini/settings.json`, which also holds unrelated user
  // settings: projecting them safely means MERGING into that file, which the
  // apply stage does not yet support, so it is an honest drop, not a clobber.
  //
  // No policy changes that outcome — there is nowhere to write and nothing that
  // reads — so a policy asking for one is a line in the manifest that will never
  // come true, and it earns a warning rather than a silent no-op.
  const reason =
    harness === 'opencode'
      ? 'OpenCode has no declarative hook config (only a code-based TypeScript plugin API), so hooks cannot be projected as files'
      : 'Gemini hooks require a safe merge into the shared .gemini/settings.json (preserving other keys); tracked as follow-up (DOR-143)';
  return {
    actions: sources.files.map((source) => ({ ...base(source), kind: 'drop' as const, reason })),
    warnings:
      policy === 'generate' || policy === 'native'
        ? [impossiblePolicyWarning(harness, policy)]
        : [],
  };
}

/**
 * Why a harness with a generated hooks file gets nothing under a `none` or
 * `native` policy — always naming the manifest, since the manifest is the only
 * reason.
 *
 * A `native` policy additionally gets the correction it is asking for: the
 * harness's own documented hook paths when `vendor-facts` has a dated cell for
 * it, and otherwise the file DorkOS would write. Nothing about another company's
 * software is asserted without the page it came from.
 */
function policyDropReason(
  harness: HarnessId,
  policy: 'none' | 'native',
  generatedTarget: string
): string {
  const label = HARNESS_LABELS[harness];
  const head = `hooks are not projected to ${label} — your manifest's hookPolicies says ${policy}`;
  if (policy === 'none') return head;

  const facts = hooksFactsFor(harness);
  const reads = facts
    ? `it reads ${facts.readPaths.project.join(', ')} (${facts.source.url}, read ${facts.source.fetchedAt})`
    : `DorkOS writes ${generatedTarget} for it when hookPolicies says generate`;
  return `${head}, but ${label} does not read ${CLAUDE_SETTINGS_SOURCE}; ${reads}`;
}

/**
 * What `manifest.hookPolicies` asks for one harness, or `undefined` when it says
 * nothing about it — which is the default and means "carry on as before".
 *
 * The first entry naming the harness wins. `tool` is a free string in the schema
 * on purpose: an entry naming something that is not an enabled harness is a line
 * that reaches nothing, and `manifest/notices.ts` says so rather than the schema
 * rejecting the whole file over it.
 */
export function hookPolicyFor(
  manifest: HarnessManifest,
  harness: HarnessId
): HookProjection | undefined {
  return manifest.hookPolicies.find((policy) => policy.tool === harness)?.projection;
}

/**
 * Where an installed package's hooks would land in this repo, and where the
 * manifest stops them.
 *
 * The question `--allow-hooks` has to answer before it records a durable yes.
 * Consent is stored per package and outlives the manifest that was in force
 * when it was given, so recording one against a projection the manifest
 * suppresses is a yes that goes live, unprompted, the day somebody deletes a
 * `hookPolicies` line (DOR-1858 review).
 *
 * It is derived from the same two facts {@link planHooks} uses, and it has to
 * stay that way — a second copy of "which harnesses can receive hooks" would be
 * free to disagree with the plan the person is looking at:
 *
 * - a harness with no hooks mechanism at all (OpenCode, Gemini) is not
 *   `suppressed`, it is simply not reachable, and no manifest line is to blame;
 * - `none` stops every harness, and `native` stops the ones the engine writes a
 *   file for — both mean "the engine writes nothing here", which is exactly what
 *   an installed package's hooks need in order to arrive.
 *
 * @param manifest - the validated manifest, for its enabled set and policies.
 * @returns the enabled harnesses an installed package's hooks would reach, and
 *   the ones a `hookPolicies` entry stops them reaching, each with that entry's
 *   `projection`.
 */
export function pluginHookReach(manifest: HarnessManifest): {
  reached: HarnessId[];
  suppressed: { harness: HarnessId; projection: HookProjection }[];
} {
  const reached: HarnessId[] = [];
  const suppressed: { harness: HarnessId; projection: HookProjection }[] = [];

  for (const harness of manifest.harnesses) {
    // The harnesses with nowhere to write are out of this question entirely:
    // their hooks never arrive, policy or no policy, so blaming the manifest
    // would send somebody to delete a line that changes nothing.
    const writes = harness === 'claude-code' || STANDALONE_HOOK_HARNESSES[harness] !== undefined;
    if (!writes) continue;

    const policy = hookPolicyFor(manifest, harness);
    const stopped = policy === 'none' || (policy === 'native' && harness !== 'claude-code');
    if (stopped && policy) suppressed.push({ harness, projection: policy });
    else reached.push(harness);
  }

  return { reached, suppressed };
}

/**
 * The drops that stand in for a suppressed `.claude/settings.local.json` merge:
 * one per package whose hooks would have been merged, naming its own file.
 *
 * The merge itself is a single action for every package at once, so it has no
 * source to name; a drop must have one, or nothing connects the line back to the
 * declaration it is about (P6).
 */
export function dropSuppressedPluginHookMerge(
  contributors: readonly InstalledPlugin[]
): ProjectionAction[] {
  const reason = `hooks are not projected to ${HARNESS_LABELS['claude-code']} — your manifest's hookPolicies says none`;
  return contributors
    .filter((plugin) => plugin.relDir !== undefined && hasHooks(plugin.hooks))
    .map((plugin) => ({
      kind: 'drop' as const,
      artifact: 'hook' as const,
      harness: 'claude-code' as const,
      provenance: 'installed' as const,
      name: 'plugin-hooks',
      source: `${plugin.relDir as string}/hooks/hooks.json`,
      reason,
    }));
}

/** A manifest policy asking for something this harness has no mechanism for. */
function impossiblePolicyWarning(
  harness: HarnessId,
  policy: 'native' | 'generate'
): ProjectionWarning {
  const label = HARNESS_LABELS[harness];
  return {
    artifact: 'hook',
    harness,
    name: 'hooks',
    reason:
      policy === 'generate'
        ? harness === 'claude-code'
          ? `your manifest's hookPolicies asks for generate, but DorkOS writes no hooks file for ${label} — it reads ${CLAUDE_SETTINGS_SOURCE} itself`
          : `your manifest's hookPolicies asks for generate, but there is no hooks file DorkOS can write for ${label}`
        : `your manifest's hookPolicies says native, but ${label} does not read ${CLAUDE_SETTINGS_SOURCE}`,
  };
}

/**
 * Generate one harness's standalone hooks file from the Claude hooks config:
 * drop unmappable events, and warn (without dropping) when a projected hook
 * command carries a Claude-only substitution token the target harness cannot
 * resolve.
 *
 * Emits NO generate action when the merged config produces zero mappable hooks
 * for the target. The apply stage then prunes a file it can prove it wrote at
 * that path, and reports anything else there as a conflict rather than deleting
 * somebody's own hooks.
 */
function planStandaloneHooks(
  harness: HarnessId,
  spec: StandaloneHookSpec,
  sources: HookSources,
  claudeHooks?: ClaudeHooksConfig
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  if (!claudeHooks) return { actions: [], warnings: [] };

  const { content, dropped, warnings } = spec.generate(claudeHooks);
  const actions: ProjectionAction[] = [];

  if (content !== undefined) {
    const action: ProjectionAction = {
      artifact: 'hook',
      harness,
      provenance: 'authored',
      name: 'hooks',
      kind: 'generate',
      // The file this generated one was built from. With no authored settings —
      // a repository whose only hooks came from a package — that is the
      // package's own declaration, not a path nobody wrote.
      source: sources.files[0] ?? CLAUDE_SETTINGS_SOURCE,
      target: spec.target,
    };
    setActionContent(action, content);
    actions.push(action);
  }

  for (const d of dropped) {
    actions.push({
      artifact: 'hook',
      harness,
      provenance: 'authored',
      name: d.event,
      // The file that declared THIS event, so a person opens the right one.
      source: sources.byEvent.get(d.event) ?? sources.files[0] ?? CLAUDE_SETTINGS_SOURCE,
      kind: 'drop',
      reason: d.reason,
    });
  }

  return {
    actions,
    warnings: warnings.map((w) => ({
      artifact: 'hook' as const,
      harness,
      name: w.event,
      // The file that declared THIS event — the same resolution the dropped
      // branch above uses, and for one more reason besides opening the right
      // file. A warning is matched to the artifact it concerns by its source
      // (the reason DOR-1845's review added one to the unreadable-hook
      // warning): named after the EVENT while the generated action is named
      // `hooks`, a sourceless warning matches nothing and is reported as a
      // thing of its own — a second entry about one file, carrying one harness
      // and silent about the rest.
      source: sources.byEvent.get(w.event) ?? sources.files[0] ?? CLAUDE_SETTINGS_SOURCE,
      reason: w.reason,
    })),
  };
}
