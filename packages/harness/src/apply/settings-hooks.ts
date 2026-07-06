/**
 * Managed-hook merge for the user-owned `.claude/settings.local.json`.
 *
 * Installed-plugin hooks reach the Claude Code harness by merging INTO this
 * machine-local settings file rather than owning it wholesale: it may also hold
 * the user's own local settings and hooks, so the whole-file `generate`
 * ownership model (which regenerates and prunes freely) must NOT apply here. The
 * merge touches only the managed entries — hook matcher groups whose command
 * references a path under the repo's `.dork/plugins/` install root — and leaves
 * every user-authored hook and every other settings key untouched.
 *
 * @module apply/settings-hooks
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClaudeHooksConfig, HookMatcherGroup } from '../generate/hooks.js';

/** The parsed settings file: a `hooks` map plus any other user-owned keys. */
interface SettingsFile {
  hooks?: ClaudeHooksConfig;
  [key: string]: unknown;
}

/** Read + parse the settings file; `{}` when absent or unparseable (never throws). */
function readSettingsFile(absTarget: string): SettingsFile {
  if (!existsSync(absTarget)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(absTarget, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as SettingsFile) : {};
  } catch {
    return {};
  }
}

/** Write the settings file as 2-space JSON (Claude Code itself rewrites this file). */
function writeSettingsFile(absTarget: string, settings: SettingsFile): void {
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, JSON.stringify(settings, null, 2) + '\n');
}

/** True when a matcher group is engine-managed: a hook command references the install root. */
function isManagedGroup(group: HookMatcherGroup, needle: string): boolean {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(needle))
  );
}

/** Drop every managed matcher group, preserving user groups and dropping now-empty events. */
function stripManagedHooks(
  hooks: ClaudeHooksConfig | undefined,
  needle: string
): ClaudeHooksConfig {
  const out: ClaudeHooksConfig = {};
  if (!hooks) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isManagedGroup(g, needle));
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** Concatenate the managed groups onto the (already user-only) hooks, per event. */
function appendManagedHooks(
  existing: ClaudeHooksConfig,
  managed: ClaudeHooksConfig
): ClaudeHooksConfig {
  const out: ClaudeHooksConfig = { ...existing };
  for (const [event, groups] of Object.entries(managed)) {
    out[event] = [...(out[event] ?? []), ...groups];
  }
  return out;
}

/** Reconcile a settings file's `hooks` to exactly the user entries plus `managed`. */
function reconcileHooks(
  settings: SettingsFile,
  managed: ClaudeHooksConfig,
  needle: string
): SettingsFile {
  const userHooks = stripManagedHooks(settings.hooks, needle);
  const nextHooks = appendManagedHooks(userHooks, managed);
  const next: SettingsFile = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

/**
 * Merge the managed plugin hooks into the settings file: strip the previously
 * managed entries, append the current managed set, and rewrite. Every
 * user-authored hook and non-hook key survives untouched.
 *
 * @param absTarget - absolute path to `.claude/settings.local.json`.
 * @param managed - the managed hooks to install (already token-rewritten).
 * @param needle - the install-root path every managed hook command references.
 */
export function mergeManagedHooks(
  absTarget: string,
  managed: ClaudeHooksConfig,
  needle: string
): void {
  const settings = readSettingsFile(absTarget);
  writeSettingsFile(absTarget, reconcileHooks(settings, managed, needle));
}

/**
 * Sweep managed plugin hooks out of the settings file (uninstall path). Removes
 * only the managed matcher groups; a now-empty `hooks` key is dropped so the
 * file returns to its pre-projection shape. No-op (returns `false`) when the
 * file is absent or carries no managed entries.
 *
 * @param absTarget - absolute path to `.claude/settings.local.json`.
 * @param needle - the install-root path every managed hook command references.
 * @returns `true` when the file was rewritten (managed entries were removed).
 */
export function sweepManagedHooks(absTarget: string, needle: string): boolean {
  if (!existsSync(absTarget)) return false;
  const settings = readSettingsFile(absTarget);
  if (!settings.hooks) return false;
  const stripped = stripManagedHooks(settings.hooks, needle);
  if (JSON.stringify(stripped) === JSON.stringify(settings.hooks)) return false;
  const next: SettingsFile = { ...settings };
  if (Object.keys(stripped).length > 0) next.hooks = stripped;
  else delete next.hooks;
  writeSettingsFile(absTarget, next);
  return true;
}

/**
 * Whether applying the managed-hook merge would change the file — the `--check`
 * drift signal. True when the file is missing or its managed portion differs
 * from `managed`.
 *
 * @param absTarget - absolute path to `.claude/settings.local.json`.
 * @param managed - the managed hooks the plan wants installed.
 * @param needle - the install-root path every managed hook command references.
 */
export function managedHooksDrift(
  absTarget: string,
  managed: ClaudeHooksConfig,
  needle: string
): boolean {
  if (!existsSync(absTarget)) return true;
  const settings = readSettingsFile(absTarget);
  const reconciled = reconcileHooks(settings, managed, needle);
  return JSON.stringify(settings) !== JSON.stringify(reconciled);
}
