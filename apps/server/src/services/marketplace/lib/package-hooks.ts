/**
 * Read a package's Claude-plugin hooks into flat `{ event, matcher?, command }`
 * rows, plus every declaration that could not be read.
 *
 * Claude Code reads hooks from `hooks/hooks.json` AND from the `hooks` field of
 * `.claude-plugin/plugin.json` (a path to another file, an inline object, or a
 * list of either), so both are read ({@link declarationsOf}). Every file is read
 * through {@link readDeclarationJson}: nothing outside the package is opened.
 *
 * Parsing mirrors `readPluginHooks` in `packages/harness/src/sources/installed.ts`,
 * the reader that feeds Harness Sync, including its tolerance for both the
 * settings-style `{ hooks: {…} }` wrapper and a bare `{ Event: […] }` object.
 * It is reimplemented rather than imported because the harness copy is module
 * private, and because the two want different things from a bad declaration:
 * the projector only needs what it can use, while the preview has to say out
 * loud what it could not read. Every discarded declaration therefore comes back
 * in `unreadable`.
 *
 * A hook of a type other than `command` (`http`, `mcp_tool`, `prompt`, `agent`)
 * is reported unreadable, never dropped: it runs, and the preview has no row
 * that says what it does, so "declares a hook we cannot show" is the honest
 * answer (DOR-2195).
 *
 * Facts this reader deliberately does NOT encode, because the preview's job is
 * to disclose what the package declares, not to predict every downstream filter:
 *
 * - For a PROJECT-scoped install those hooks reach a harness settings file only
 *   for a `plugin` or `skill-pack`, and only after a person approves that exact
 *   command set for that project (`services/harness/hook-approval.ts`, DOR-522).
 *   A GLOBAL plugin is loaded straight into every Claude Code session by the SDK
 *   (`plugin-activation.ts`), hooks included. The UI therefore says the package
 *   "declares" these commands rather than that it "will run" them.
 * - `readPluginHooks` salvages exactly the same commands this reader does — the
 *   same keep rule at the event, group and command level (DOR-646) — and both
 *   sides report what they discarded (DOR-1724).
 *
 * @module services/marketplace/lib/package-hooks
 */
import type { PreviewHook, UnreadablePreviewHook } from '../types.js';
import {
  declarationsOf,
  isRecord,
  readDeclarationJson,
  type DeclarationSource,
} from './package-declarations.js';
import { EFFECT_BEARING_PATHS } from '@dorkos/marketplace';

/** Package-relative path of the default Claude-plugin hooks declaration. */
export const HOOKS_FILE = EFFECT_BEARING_PATHS.hooksFile;

/** What {@link readPackageHooks} found. */
export interface PackageHooks {
  /** Every readable command hook, in declaration order. */
  hooks: PreviewHook[];
  /** Every declaration, or event, that could not be read. */
  unreadable: UnreadablePreviewHook[];
}

/**
 * Collect the command hooks of one parsed declaration: a hooks file, an inline
 * plugin.json value, or a skill's frontmatter `hooks`.
 *
 * @param raw - The parsed declaration.
 * @param path - Where it was declared, for the unreadable report.
 * @param out - Where hooks and unreadable entries are collected.
 * @param source - The skill or command file the hooks belong to, when they
 *   are scoped to one (they run while it is in use); absent for plugin hooks.
 */
export function collectHooks(raw: unknown, path: string, out: PackageHooks, source?: string): void {
  // Accept both `{ hooks: {…} }` (settings-style) and a bare `{ Event: […] }` object.
  const hooksObj = isRecord(raw) && 'hooks' in raw ? raw.hooks : raw;
  if (!isRecord(hooksObj)) {
    out.unreadable.push({ path });
    return;
  }
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) {
      out.unreadable.push({ path, event });
      continue;
    }
    let salvaged = 0;
    let unshown = false;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const { matcher, hooks: entries } = group;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        if (entry.type !== undefined && entry.type !== 'command') {
          unshown = true;
          continue;
        }
        const text = entry.command;
        if (typeof text !== 'string' || text.length === 0) continue;
        out.hooks.push({
          event,
          ...(typeof matcher === 'string' && matcher.length > 0 ? { matcher } : {}),
          command: text,
          ...(source !== undefined && { source }),
        });
        salvaged += 1;
      }
    }
    // An event that declares matcher groups but yields no command string, or
    // declares a hook of a kind the preview cannot show, is a declaration we
    // failed to read, not an empty one.
    if (unshown || (salvaged === 0 && groups.length > 0)) out.unreadable.push({ path, event });
  }
}

/**
 * Read one source: a file (skipped when absent and optional) or an inline value.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param source - Where the declaration lives.
 * @param out - Where hooks and unreadable entries are collected.
 */
async function readSource(
  packagePath: string,
  source: DeclarationSource,
  out: PackageHooks
): Promise<void> {
  if (source.kind === 'inline') {
    collectHooks(source.value, source.path, out);
    return;
  }
  const read = await readDeclarationJson(packagePath, source.path);
  if (read.kind === 'absent') {
    if (source.required) out.unreadable.push({ path: source.path });
    return;
  }
  if (read.kind === 'unreadable') {
    out.unreadable.push({ path: source.path });
    return;
  }
  collectHooks(read.value, source.path, out);
}

/**
 * Every hook the package at `packagePath` declares, from `hooks/hooks.json` and
 * from `.claude-plugin/plugin.json`'s `hooks`.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param pluginJson - The package's plugin.json, when it has a readable one.
 * @returns The hooks, in declaration order, and every declaration that could not be read.
 */
export async function readPackageHooks(
  packagePath: string,
  pluginJson: Record<string, unknown> | undefined
): Promise<PackageHooks> {
  const out: PackageHooks = { hooks: [], unreadable: [] };
  for (const source of declarationsOf(HOOKS_FILE, pluginJson?.hooks)) {
    await readSource(packagePath, source, out);
  }
  return out;
}
