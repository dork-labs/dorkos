/**
 * Keep an agent's file tools out of the mini apps OTHER agents made (DOR-3068).
 *
 * An agent's mini apps live in its own folder, `<agentHome>/.dork/extensions/`,
 * and while one runs separately the edits its author makes to its server code
 * keep running without a person's click (`extensions/pin/extension-path-trust.ts`).
 * That trust is the author's alone: a write by any other agent to those files
 * is exactly the change a person should see first. Path trust already refuses
 * a copy that is not where its author put it, but nothing stopped another
 * agent editing the files in place, so every launch denies the file tools
 * (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) every other registered
 * agent's `.dork/extensions/` folder. The launching agent's own stays
 * writable: that is where it builds, unless the turn is marked or ceilinged
 * ({@link ownExtensionsWritable}).
 *
 * Each folder is named by every spelling the file tools may see (the folder
 * as registered, through its home's real path, and its own real path), with
 * the `//` absolute anchoring `directory-grants.ts` documents, so a symlinked
 * home cannot slip past the rule. A deny rule holds at every permission
 * level, Bypass included. Bash is not covered, as for every file rule.
 *
 * A folder whose path no rule can name exactly is skipped with a warning,
 * never fails the launch: it is another agent's folder, and one odd name must
 * not stop every turn of every agent. The global extensions folder is never
 * denied here, even when an agent's home holds it (a home of `~`): it is a
 * person's, and its copies are pinned by content.
 *
 * @module services/runtimes/claude-code/folder-settings/agent-extensions-deny
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { ExtensionsConfig } from '../../../extensions/extension-enable-resolution.js';
import { logger } from '../../../../lib/logger.js';
import { markedBoundOf } from '../../../core/turn-power/turn-levels.js';
import { heldToACeiling } from '../turn-permission.js';
import { writeDenyRules } from '../messaging/directory-grants.js';

/** The real path of `target`, or `undefined` when it does not exist. */
function realpathOrUndefined(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/** Every spelling of one home's `.dork/extensions` folder, the canonical one first. */
function extensionFolderNames(home: string): string[] {
  const resolved = path.resolve(home);
  const folder = path.join(resolved, '.dork', 'extensions');
  const names = new Set<string>();
  const realFolder = realpathOrUndefined(folder);
  if (realFolder) names.add(realFolder);
  names.add(folder);
  const realHome = realpathOrUndefined(resolved);
  if (realHome) names.add(path.join(realHome, '.dork', 'extensions'));
  return [...names];
}

/** The canonical spelling of a home's extensions folder, for comparisons. */
function canonicalExtensionsOf(home: string): string {
  return extensionFolderNames(home)[0]!;
}

/**
 * The deny rules that keep this launch's file tools out of every other
 * registered agent's mini apps. Pure apart from reading real paths.
 *
 * @param ownHome - The launching agent's home, or undefined when the turn
 *   runs as no agent (then every agent's mini apps are denied).
 * @param agentHomes - Every registered agent's home.
 * @param dorkHome - DorkOS's data directory, whose `extensions/` is never denied here.
 * @returns The rules, deduplicated.
 */
export function otherAgentsExtensionsDenyRules(
  ownHome: string | undefined,
  agentHomes: readonly string[],
  dorkHome: string
): string[] {
  const keep = new Set<string>([
    path.join(realpathOrUndefined(path.resolve(dorkHome)) ?? path.resolve(dorkHome), 'extensions'),
    path.join(path.resolve(dorkHome), 'extensions'),
  ]);
  if (ownHome) for (const name of extensionFolderNames(ownHome)) keep.add(name);
  const rules = new Set<string>();
  for (const home of agentHomes) {
    if (!path.isAbsolute(home)) continue;
    if (keep.has(canonicalExtensionsOf(home))) continue;
    for (const folder of extensionFolderNames(home)) {
      if (keep.has(folder)) continue;
      const denied = writeDenyRules(folder, 'folder');
      if (!denied) {
        logger.warn(
          `[claude-code] Could not keep other agents out of ${folder}: its path has a ` +
            `character file rules cannot match`
        );
        continue;
      }
      for (const rule of denied) rules.add(rule);
    }
  }
  return [...rules];
}

/**
 * The home whose own extensions this launch may write: the turn's agent's,
 * unless the turn read a stranger's words (`markedBoundOf`, which counts a
 * chat a stranger reached) or runs under a ceiling. Then its own mini apps
 * are denied like every other agent's, so a stranger cannot steer an edit
 * that path trust would run without a click.
 *
 * @param session - The session's ceilings.
 * @param sessionId - The launching session.
 * @param ownHome - The turn's agent's home, when it runs as one.
 * @returns The home to leave writable, or undefined for none.
 */
export function ownExtensionsWritable(
  session: Parameters<typeof heldToACeiling>[0],
  sessionId: string,
  ownHome: string | undefined
): string | undefined {
  if (!ownHome || heldToACeiling(session)) return undefined;
  return markedBoundOf(sessionId, ownHome) === undefined ? ownHome : undefined;
}

/**
 * Every agent home whose mini apps a launch must keep out of: each registered
 * agent's, and each folder a stored approval names as an extension's author
 * (`authorHome`, DOR-3068), which path trust is keyed to even when that agent
 * is no longer registered. A registry that cannot list (absent, or a narrow
 * stand-in without `listWithPaths`) adds none rather than failing the launch.
 *
 * @param registry - The agent registry the launch was given, if any.
 * @param approvals - `config.extensions`, for the author folders it records.
 */
export function otherAgentHomesOf(
  registry: Partial<Pick<AgentRegistryPort, 'listWithPaths'>> | null | undefined,
  approvals: Partial<Pick<ExtensionsConfig, 'approvedSources'>> = {}
): string[] {
  const registered =
    typeof registry?.listWithPaths === 'function'
      ? registry.listWithPaths().map((agent) => agent.projectPath)
      : [];
  // Every folder an approval names as an author too, registered or not: path
  // trust is keyed to that folder, so it is denied whatever the registry says.
  const authors = Object.values(approvals.approvedSources ?? {}).flatMap((source) =>
    source.authorHome ? [source.authorHome] : []
  );
  return [...new Set([...registered, ...authors])];
}

/**
 * Add {@link otherAgentsExtensionsDenyRules} to a launch's settings, beside
 * any rules already there. Every launch, a teammate's too.
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param ownHome - The launching agent's home, when the turn runs as one.
 * @param agentHomes - Every registered agent's home.
 * @param dorkHome - DorkOS's data directory.
 */
export function applyOtherAgentsExtensionsDeny(
  sdkOptions: Options,
  ownHome: string | undefined,
  agentHomes: readonly string[],
  dorkHome: string
): void {
  const rules = otherAgentsExtensionsDenyRules(ownHome, agentHomes, dorkHome);
  if (rules.length === 0) return;
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: { deny?: string[] } }).permissions ?? {}) as {
    deny?: string[];
    [key: string]: unknown;
  };
  sdkOptions.settings = {
    ...base,
    permissions: { ...permissions, deny: [...(permissions.deny ?? []), ...rules] },
  } as Options['settings'];
}
