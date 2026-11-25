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
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { ExtensionsConfig } from '../../../extensions/extension-enable-resolution.js';
import { logger } from '../../../../lib/logger.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { configManager } from '../../../core/config-manager.js';
import { heldToACeiling } from '../turn-permission.js';
import { marksOf } from '../../../core/turn-power/turn-levels.js';
import { marksHold } from '../../../core/turn-power/turn-marks.js';
import {
  addLaunchDenyRules,
  realpathOrUndefined,
  writeDenyRules,
} from '../messaging/directory-grants.js';

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
 * Whether `home`'s own `.dork/extensions` folder is one the deny rule can keep a held turn out
 * of: every home's but one whose folder IS DorkOS's global extensions folder (a home of `~`),
 * which {@link otherAgentsExtensionsDenyRules} never denies.
 *
 * @param home - The agent's home.
 * @param dorkHome - DorkOS's data directory.
 */
export function ownExtensionsDeniable(home: string, dorkHome: string = resolveDorkHome()): boolean {
  const global = path.join(path.resolve(dorkHome), 'extensions');
  const realGlobal = path.join(
    realpathOrUndefined(path.resolve(dorkHome)) ?? path.resolve(dorkHome),
    'extensions'
  );
  return !extensionFolderNames(home).some((name) => name === global || name === realGlobal);
}

/**
 * Whether `file` is inside any of `folders`, as written or through its real path. The file need
 * not exist yet: its closest existing parent is read through its real path, so a write through a
 * link into one of the folders counts.
 *
 * @param file - An absolute path a file tool was aimed at.
 * @param folders - Every spelling of the folders in question.
 */
export function isInsideAnyFolder(file: string, folders: readonly string[]): boolean {
  const target = path.resolve(file);
  let probe = target;
  let real: string | undefined;
  while (real === undefined && probe !== path.dirname(probe)) {
    real = realpathOrUndefined(probe);
    if (real === undefined) probe = path.dirname(probe);
  }
  const spellings = [target];
  if (real !== undefined) spellings.push(path.join(real, path.relative(probe, target)));
  return folders.some((folder) =>
    spellings.some((name) => name === folder || name.startsWith(folder + path.sep))
  );
}

/**
 * Whether `file` is inside `home`'s own `.dork/extensions` folder, by any spelling
 * {@link extensionFolderNames} knows ({@link isInsideAnyFolder}).
 *
 * @param file - An absolute path a file tool was aimed at.
 * @param home - The agent's home.
 */
export function isInOwnExtensions(file: string, home: string): boolean {
  return isInsideAnyFolder(file, extensionFolderNames(home));
}

/**
 * What an agent is told when its own mini apps folder is read-only this turn: the rule, and
 * the route that works (DOR-4851). The refusal on its file tools and `create_extension`'s
 * reply both say it, so the agent never guesses, and never hands the person a Terminal copy.
 *
 * @param folder - The folder that is read-only, when known.
 */
export function ownExtensionsReadOnlyMessage(folder?: string): string {
  return (
    `Your mini apps folder${folder ? ` (${folder})` : ''} is read-only in this turn. ` +
    'This turn read words from someone other than your owner (a room with another person in ' +
    'it, Telegram, Slack, a mini app’s post) or runs under a limit, and code in that folder ' +
    'runs without a click. That rule is on purpose. ' +
    'Build in your owner’s personal marketplace instead: ' +
    'marketplace_create_package (type "plugin") once, then write the app into ' +
    '<package>/.dork/extensions/<app id>/. For each new version raise "version" in the ' +
    'package’s .claude-plugin/plugin.json (read first) and .dork/manifest.json, and in the ' +
    'app’s extension.json. Then marketplace_install (first time) or marketplace_update with ' +
    'names and apply: true. Each version is one install card your owner approves in DorkOS; ' +
    'an app with server code also waits for them to allow it in Activity. ' +
    'Never ask anyone to copy files in from Terminal.'
  );
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
 * unless the turn runs under a ceiling or carries a mark that holds (a Wi-Fi
 * sign-in's, `marksHold`). Then its own mini apps are denied like every other
 * agent's: path trust runs those files without a click, so an edit there is a
 * raise, which a mark still holds back (Security S1 on #3280). It lowers
 * nothing else.
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
  return ownExtensionsHeldByMark(sessionId, ownHome) ? undefined : ownHome;
}

/**
 * Whether a mark that holds keeps this agent out of its own mini apps this turn: the mark half
 * of {@link ownExtensionsWritable}, for callers that know the ceiling some other way.
 *
 * @param sessionId - The calling session.
 * @param ownHome - The agent's home.
 */
export function ownExtensionsHeldByMark(sessionId: string | undefined, ownHome: string): boolean {
  return marksHold(marksOf(sessionId, ownHome));
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
  addLaunchDenyRules(sdkOptions, otherAgentsExtensionsDenyRules(ownHome, agentHomes, dorkHome));
}

/**
 * Keep one launch's file tools out of every other agent's mini apps, and out
 * of its own when the turn may not write them ({@link ownExtensionsWritable}).
 * Reads the stored approvals for author folders and DorkOS's data directory.
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param turn - The session's ceilings, its id, the turn's agent home and the
 *   agent registry the launch was given.
 */
export function applyLaunchExtensionsDeny(
  sdkOptions: Options,
  turn: {
    session: Parameters<typeof heldToACeiling>[0];
    sessionId: string;
    agentHome: string | undefined;
    registry: Parameters<typeof otherAgentHomesOf>[0];
  }
): void {
  applyOtherAgentsExtensionsDeny(
    sdkOptions,
    ownExtensionsWritable(turn.session, turn.sessionId, turn.agentHome),
    // Author folders an approval records count even when no longer registered.
    otherAgentHomesOf(turn.registry, configManager.get('extensions')),
    resolveDorkHome()
  );
}
