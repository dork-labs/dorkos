/**
 * Below Full, an agent's folder settings allow only what a person approved (DOR-5237).
 *
 * One check per launch. On every call it reads the widening entries in the settings of the
 * folders the launch loads (`folder-settings-files.ts`), sets aside the ones a person or the
 * launch itself vouched for, and says whether the call needs a person: when a remaining entry
 * could allow it (`ruleMayAllow`) and no vouched rule covers this exact call (`ruleCovers`). The
 * held turn's hook (`held-turn-hook.ts`) turns that into an `ask`, which only ever adds a card.
 *
 * Vouched for: the agent's yes on its folder allow list (`folder-allow-consent.ts`) in its home;
 * elsewhere, the folder settings the launch itself compared and loaded, and local settings whose
 * content a person approved (`repo-local-settings.ts`); everywhere, what the launch passes itself
 * and what a person allowed this session ({@link FolderAllowWatch.rememberPersonAnswers}). A
 * file DorkOS cannot read, or a check that cannot finish, needs a person.
 *
 * @module services/runtimes/claude-code/tool-gate/folder-file-allows
 */
import path from 'node:path';
import type { Options, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { expandTilde } from '../../../../lib/boundary.js';
import { folderAllowsFromSettings } from '../folder-settings/apply-folder-allows.js';
import { grantsFromSettings } from '../messaging/directory-grants.js';
import { lastApprovedRules } from '../folder-settings/folder-allow-consent.js';
import { allowRulesOf, rememberPersonAlwaysAllow } from '../folder-settings/person-always-allow.js';
import { isRepoConfigApproved } from '../repo-settings/repo-config-consent.js';
import { readLocalSettings } from '../repo-settings/repo-local-settings.js';
import { reachesFiles, ruleCovers, ruleMayAllow } from './folder-rule-match.js';
import {
  isTheHome,
  readFolderSettingsEntries,
  samePlace,
  settingsFolders,
  SETTINGS_FILES,
  type FolderSettingsEntries,
  type SettingsFileName,
} from './folder-settings-files.js';

/** Who a launch is for and where it stands. */
export interface FolderFileAllowsTurn {
  /** The registered agent the turn runs as, if any. */
  agentId: string | undefined;
  /** The registered agent home the turn resolved to, if any. */
  home: string | undefined;
  /** The folder the turn launches in. */
  cwd: string;
  /** DorkOS's data folder. */
  dorkHome: string;
  /** The allow rules the launch passes itself (`settings.permissions.allow`). */
  launchAllows: readonly string[];
  /** The folders the launch opens itself (this turn's grants). */
  launchDirs: readonly string[];
  /** The person's home folder as the launch's Claude Code sees it. */
  userHome: string;
  /**
   * The working folder's committed settings as the launch's repo check compared and loaded them
   * (`launch-repo-config.ts`), if it did: the folder by real path and what that read held.
   */
  compared?: { folder: string; rules: readonly string[]; dirs: readonly string[] };
}

/** The approval records the check reads, and the one a person's Always allow writes. */
export interface FolderAllowRecords {
  /** The rules behind the agent's current yes on its folder allow list. */
  approvedRules(agentId: string, home: string): readonly string[] | undefined;
  /**
   * A folder's local settings as they read now, when that content needs no approval or has one:
   * its allow rules and folder entries from the same read. `undefined` otherwise.
   */
  approvedLocalSettings(
    folder: string,
    dorkHome: string
  ): { rules: readonly string[]; dirs: readonly string[] } | undefined;
  /** Keep a person's Always allow, so the next launch treats it as approved too. */
  rememberPersonAlwaysAllow(
    turn: { agentId: string | undefined; home: string | undefined; cwd: string; dorkHome: string },
    atHome: boolean,
    updates: readonly PermissionUpdate[]
  ): void;
}

/** The records as DorkOS keeps them. */
const STORED_RECORDS: FolderAllowRecords = {
  approvedRules: lastApprovedRules,
  approvedLocalSettings: (folder, dorkHome) => {
    const local = readLocalSettings(folder, dorkHome);
    if (local === null) return { rules: [], dirs: [] };
    return local.approvable && isRepoConfigApproved('local', local.digest)
      ? local.widening
      : undefined;
  },
  rememberPersonAlwaysAllow,
};

/** One launch's check, and the wrapper that teaches it a person's answers. */
export interface FolderAllowWatch {
  /** Whether this call must go to a person because only an unapproved folder rule could allow it. */
  mustAsk(toolName: string, input: Record<string, unknown>): Promise<boolean>;
  /**
   * Wrap a launch's `canUseTool` so the rules a person adds by answering Always allow count as
   * approved from that answer on (this session) and are recorded for the next launch.
   */
  rememberPersonAnswers<A extends unknown[]>(
    canUseTool: (...args: A) => Promise<PermissionResult>
  ): (...args: A) => Promise<PermissionResult>;
}

/** What one folder holds that counts as approved, besides what every folder shares. */
interface FolderState {
  /** The folder whose `.claude/` is read. */
  folder: string;
  /** Whether it is the registered agent home: its yes is the folder allow list's. */
  home: boolean;
  /** Its files read: the person's own home folder holds their account settings, not a folder's. */
  files: readonly SettingsFileName[];
  /** What its files held at launch that the launch vouched for (never the home's). */
  loaded: FolderSettingsEntries;
}

/** A folder entry, resolved against the settings folder that names it. */
function dirKey(dir: string, base: string): string {
  return dir.startsWith('~') ? dir : path.resolve(base, dir);
}

/**
 * Build one launch's check. Which folders it reads is settled once (`folder-settings-files.ts`);
 * their files and the records are read on every call.
 *
 * @param turn - Who the launch is for and where it stands.
 * @param records - The approval records; the stored ones unless a test says otherwise.
 */
export function watchFolderAllows(
  turn: FolderFileAllowsTurn,
  records: FolderAllowRecords = STORED_RECORDS
): FolderAllowWatch {
  // The home's own approvals, by any spelling; with no agent id there is no yes, so none.
  const isHome = (folder: string) => turn.home !== undefined && isTheHome(folder, turn.home);
  const where = settingsFolders(turn.cwd, turn.userHome);
  const states: FolderState[] = where.folders.map((folder) => {
    const files: readonly SettingsFileName[] = samePlace(folder, turn.userHome)
      ? ['settings.local.json']
      : SETTINGS_FILES;
    return { folder, home: isHome(folder), files, loaded: loadedAtLaunch(folder, files) };
  });
  const answered = new Set<string>();
  const answeredDirs = new Set<string>();
  const launchDirs = new Set(turn.launchDirs.map((dir) => dirKey(dir, turn.cwd)));

  /**
   * What a folder's files held at launch that counts as approved: its committed settings only as
   * the launch's repo check read them, for the folder it compared, and its local settings when a
   * person approved that content or it needed none. Nothing for the agent's home.
   */
  function loadedAtLaunch(
    folder: string,
    files: readonly SettingsFileName[]
  ): FolderSettingsEntries {
    const out: FolderSettingsEntries = { rules: [], dirs: [], unreadable: false };
    if (isHome(folder)) return out;
    try {
      const compared = turn.compared;
      if (
        compared !== undefined &&
        files.includes('settings.json') &&
        samePlace(folder, compared.folder)
      ) {
        out.rules.push(...compared.rules);
        out.dirs.push(...compared.dirs);
      }
      if (files.includes('settings.local.json')) {
        const local = records.approvedLocalSettings(folder, turn.dorkHome);
        out.rules.push(...(local?.rules ?? []));
        out.dirs.push(...(local?.dirs ?? []));
      }
    } catch {
      // Nothing vouched for: everything in the files counts as unapproved.
      return { rules: [], dirs: [], unreadable: false };
    }
    return out;
  }

  /** The check itself; throws on a failure the caller turns into a card. */
  async function mustAskNow(toolName: string, input: Record<string, unknown>): Promise<boolean> {
    const shared = [...turn.launchAllows, ...answered];
    const approvedEverywhere = new Set(shared);
    let reaches = false;
    for (const state of states) {
      const now = readFolderSettingsEntries(state.folder, state.files);
      if (!now.unreadable && now.rules.length === 0 && now.dirs.length === 0) continue;
      // A person approved the local settings as they read now.
      const localNow =
        !state.home && state.files.includes('settings.local.json')
          ? records.approvedLocalSettings(state.folder, turn.dorkHome)
          : undefined;
      const approved = new Set([
        ...shared,
        ...(state.home
          ? turn.agentId !== undefined
            ? (records.approvedRules(turn.agentId, turn.home!) ?? [])
            : []
          : [...state.loaded.rules, ...(localNow?.rules ?? [])]),
      ]);
      for (const rule of approved) approvedEverywhere.add(rule);
      const approvedDirs = new Set([
        ...launchDirs,
        ...answeredDirs,
        ...[...state.loaded.dirs, ...(localNow?.dirs ?? [])].map((dir) =>
          dirKey(dir, state.folder)
        ),
      ]);
      reaches ||=
        now.unreadable ||
        now.rules.some((rule) => !approved.has(rule) && ruleMayAllow(rule, toolName)) ||
        (reachesFiles(toolName) &&
          now.dirs.some((dir) => !approvedDirs.has(dirKey(dir, state.folder))));
    }
    if (!reaches) return false;
    return ![...approvedEverywhere].some((rule) => ruleCovers(rule, toolName, input));
  }

  return {
    async mustAsk(toolName, input) {
      try {
        return await mustAskNow(toolName, input);
      } catch {
        // A check that could not finish can't vouch for the call: a person decides.
        return true;
      }
    },
    rememberPersonAnswers(canUseTool) {
      return async (...args) => {
        const result = await canUseTool(...args);
        const updates = result.behavior === 'allow' ? result.updatedPermissions : undefined;
        if (updates?.length) {
          for (const rule of allowRulesOf(updates)) answered.add(rule);
          for (const dir of directoriesOf(updates)) answeredDirs.add(dirKey(dir, turn.cwd));
          // Recorded for the folder the answer is kept in.
          const folder = where.alwaysAllowFolder;
          records.rememberPersonAlwaysAllow({ ...turn, cwd: folder }, isHome(folder), updates);
        }
        return result;
      };
    },
  };
}

/**
 * Build the check for one launch from the launch's own options (what it passes itself, the home
 * folder its Claude Code sees) and what its repo check compared. Call once every other step has
 * set them.
 *
 * @param sdkOptions - The launch options, read only.
 * @param turn - Who the launch is for, where it stands, and what its repo check compared.
 */
export function watchLaunchFolderAllows(
  sdkOptions: Options,
  turn: Pick<FolderFileAllowsTurn, 'agentId' | 'home' | 'cwd' | 'compared'>
): FolderAllowWatch {
  return watchFolderAllows({
    ...turn,
    dorkHome: resolveDorkHome(),
    launchAllows: folderAllowsFromSettings(sdkOptions.settings),
    launchDirs: [
      ...grantsFromSettings(sdkOptions.settings).map((grant) => grant.path),
      ...(sdkOptions.additionalDirectories ?? []),
    ],
    userHome: sdkOptions.env?.HOME ?? expandTilde('~'),
  });
}

/** The folders a batch of permission updates opens. */
function directoriesOf(updates: readonly PermissionUpdate[]): string[] {
  return updates.flatMap((update) =>
    update.type === 'addDirectories' ? [...update.directories] : []
  );
}
