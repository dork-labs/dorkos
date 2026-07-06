/**
 * Managed-hook merge for the user-owned `.claude/settings.local.json`.
 *
 * Installed-plugin hooks reach the Claude Code harness by merging INTO this
 * machine-local settings file rather than owning it wholesale: it may also hold
 * the user's own local settings and hooks, so the whole-file `generate`
 * ownership model (which regenerates and prunes freely) must NOT apply here.
 *
 * Ownership is EXPLICIT, never inferred: every engine-managed matcher group
 * carries the {@link MANAGED_HOOK_SENTINEL_KEY} sentinel (value: the owning
 * plugin's package name), written by the projector. A plugin hook that never
 * references its install path is still recognized (no duplicate on re-sync, no
 * orphan on uninstall), and a user hook that happens to mention
 * `.dork/plugins/` is never misclassified as managed. Claude Code tolerates the
 * unknown key and the tagged hook still fires (validated against CLI 2.1.197).
 *
 * Safety: the merge is a read-modify-write, so a target that exists but cannot
 * be parsed is NEVER rewritten (a naive fallback-to-empty would wipe the user's
 * settings). {@link mergeManagedHooks} aborts instead, and the apply stage
 * surfaces the abort through its conflicts channel, matching the engine's
 * stance that a real file blocking a managed target is a conflict.
 *
 * @module apply/settings-hooks
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClaudeHooksConfig, HookMatcherGroup } from '../generate/hooks.js';
import { MANAGED_HOOK_SENTINEL_KEY } from '../plan/installed-projector.js';

/** The parsed settings file: a `hooks` map plus any other user-owned keys. */
interface SettingsFile {
  hooks?: ClaudeHooksConfig;
  [key: string]: unknown;
}

/**
 * Read + parse the settings file. `undefined` distinguishes "exists but
 * unparseable" (corrupt or mid-write) from a missing file (`{}`): mutating
 * callers must abort on `undefined`, read-only callers may treat it as empty.
 */
function readSettingsFile(absTarget: string): SettingsFile | undefined {
  if (!existsSync(absTarget)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(absTarget, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as SettingsFile) : undefined;
  } catch {
    return undefined;
  }
}

/** Write the settings file as 2-space JSON (Claude Code itself rewrites this file). */
function writeSettingsFile(absTarget: string, settings: SettingsFile): void {
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, JSON.stringify(settings, null, 2) + '\n');
}

/** True when a matcher group carries the engine's ownership sentinel. */
function isManagedGroup(group: HookMatcherGroup): boolean {
  const record = group as unknown as Record<string, unknown>;
  return typeof record[MANAGED_HOOK_SENTINEL_KEY] === 'string';
}

/** Drop every managed matcher group, preserving user groups and dropping now-empty events. */
function stripManagedHooks(hooks: ClaudeHooksConfig | undefined): ClaudeHooksConfig {
  const out: ClaudeHooksConfig = {};
  if (!hooks) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isManagedGroup(g));
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
function reconcileHooks(settings: SettingsFile, managed: ClaudeHooksConfig): SettingsFile {
  const userHooks = stripManagedHooks(settings.hooks);
  const nextHooks = appendManagedHooks(userHooks, managed);
  const next: SettingsFile = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

/**
 * Merge the managed plugin hooks into the settings file: strip the previously
 * managed (sentinel-tagged) entries, append the current managed set, and
 * rewrite. Idempotent: N syncs leave exactly one copy of each managed group.
 * Every user-authored hook and non-hook key survives untouched.
 *
 * @param absTarget - absolute path to `.claude/settings.local.json`.
 * @param managed - the managed hooks to install (sentinel-tagged, token-rewritten).
 * @returns `true` when the merge was written; `false` when the target exists but
 *   could not be parsed (corrupt or mid-write), in which case NOTHING is written
 *   and the caller must surface the abort as a conflict.
 */
export function mergeManagedHooks(absTarget: string, managed: ClaudeHooksConfig): boolean {
  const settings = readSettingsFile(absTarget);
  if (settings === undefined) return false; // corrupt target: never rewrite what we cannot parse
  writeSettingsFile(absTarget, reconcileHooks(settings, managed));
  return true;
}

/**
 * Sweep managed plugin hooks out of the settings file (uninstall path). Removes
 * only the sentinel-tagged matcher groups; a now-empty `hooks` key is dropped so
 * the file returns to its pre-projection shape. No-op (returns `false`) when the
 * file is absent, unparseable, or carries no managed entries.
 *
 * @param absTarget - absolute path to `.claude/settings.local.json`.
 * @returns `true` when the file was rewritten (managed entries were removed).
 */
export function sweepManagedHooks(absTarget: string): boolean {
  if (!existsSync(absTarget)) return false;
  const settings = readSettingsFile(absTarget);
  if (settings === undefined || !settings.hooks) return false;
  const stripped = stripManagedHooks(settings.hooks);
  if (JSON.stringify(stripped) === JSON.stringify(settings.hooks)) return false;
  const next: SettingsFile = { ...settings };
  if (Object.keys(stripped).length > 0) next.hooks = stripped;
  else delete next.hooks;
  writeSettingsFile(absTarget, next);
  return true;
}

/**
 * Whether applying the managed-hook merge would change the file: the `--check`
 * drift signal. True when the file is missing, unparseable (the merge would
 * abort, which is drift the operator must resolve), or its managed portion
 * differs from `managed`. Converges to `false` immediately after a successful
 * apply of the same plan.
 *
 * @param absTarget - absolute path to `.claude/settings.local.json`.
 * @param managed - the managed hooks the plan wants installed.
 */
export function managedHooksDrift(absTarget: string, managed: ClaudeHooksConfig): boolean {
  if (!existsSync(absTarget)) return true;
  const settings = readSettingsFile(absTarget);
  if (settings === undefined) return true; // corrupt: apply would abort, so report drift
  const reconciled = reconcileHooks(settings, managed);
  return JSON.stringify(settings) !== JSON.stringify(reconciled);
}
