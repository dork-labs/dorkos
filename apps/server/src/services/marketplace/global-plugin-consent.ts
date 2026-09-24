/**
 * Who may load a globally installed package's programs into every session, and
 * who may not (DOR-2306).
 *
 * ## Why a gate here
 *
 * A globally installed plugin, skill-pack or adapter is handed to the Claude
 * Agent SDK as a local plugin (`runtimes/claude-code/messaging/plugin-activation.ts`),
 * and the SDK starts everything it declares in every session: hook commands,
 * MCP and language servers, background monitors, the commands in its `bin/`,
 * and skills that may use tools without asking. Nothing on that path used to
 * check anything, so a package reinstalled by an agent over HTTP, or a file
 * changed under `~/.dork/plugins`, ran in the next session with nobody having
 * seen it.
 *
 * The gate is on the CONTENT, at activation, for the reason `hook-approval.ts`
 * gives for project hooks: every way a global package can change (the app, the
 * CLI, the MCP tools, a hand edit) ends here, so one check covers all of them.
 *
 * ## What a person approves
 *
 * One package's exact BYTES, and the programs it declares. A declaration like
 * `${CLAUDE_PLUGIN_ROOT}/hooks/fmt.sh` says nothing about what `fmt.sh` does,
 * so a yes is bound to the content hash of the installed tree
 * (`lib/content-hash.ts`, DorkOS's own runtime state left out), and the
 * declarations ({@link activationEffectsOf}, read by the same reader the
 * install preview uses) are what the person is shown. Scheduled jobs are left
 * out of the declarations on purpose: the SDK does not load them, and each
 * arrives parked at `pending_approval` behind a gate of its own. A package
 * that declares nothing that runs on its own loads without being asked about.
 *
 * ## When it is checked
 *
 * Whenever the runtime builds its plugin list, which it re-checks at the start
 * of every turn. The hash is cached behind a stat fingerprint (size, mtime,
 * ctime and inode of every entry), so the check costs an `lstat` walk until
 * something in the tree is written. The residual, stated: a file rewritten in
 * the middle of a turn runs in that turn; the next turn leaves the package out.
 *
 * ## One approval per package
 *
 * Recording a yes removes every earlier yes for the same package, and every
 * install, update or removal of a global package forgets them first. So an
 * old approved version put back later (a downgrade, a copy from a backup) is
 * a package nobody approved, and is held back.
 *
 * ## Fail closed, whole
 *
 * A package loads only when a stored yes covers exactly what it runs now.
 * Refused, never asked, unreadable declarations, or a settings file that could
 * not be read: it is left out. The SDK has no way to load a plugin without its
 * hooks (`skipMcpDiscovery` drops only `.mcp.json`), so withholding leaves the
 * whole package out, its skills and commands included.
 *
 * ## Where the decision lives
 *
 * In the hook-decision lists (`harness.approvedHooks` / `refusedHooks`,
 * `hook-consent.ts`) as `<name>@global-<digest>`: the same decision, the same
 * operator-only store, listed and revoked by `dorkos harness hooks`. The
 * `global-` prefix keeps it from ever matching a project hook entry, and lets
 * the list say which kind it is.
 *
 * ## Where a yes is recorded
 *
 * Only where a person approved exactly that package, and only after the
 * install or update landed: the app's or the terminal's own install or update
 * (the caller sends back the disclosure and content hash it was shown, and the
 * installed copy must hash the same), a granted approval card (an agent's
 * install or update, or the card `ask-withheld-global-plugins.ts` raises for a
 * held-back package), or `dorkos marketplace held-back --allow`. Never for a
 * caller who merely may skip a card (`preApproved`).
 *
 * @module services/marketplace/global-plugin-consent
 */
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { PackageType } from '@dorkos/marketplace';
import { stableStringify } from '@dorkos/shared/capabilities';
import { disclosesAnything } from '@dorkos/shared/marketplace-schemas';
import {
  forgetApprovedEntries,
  GLOBAL_ACTIVATION_ENTRY_MARKER,
  recordApprovedEntry,
  recordRefusedEntry,
  storedHookDecisions,
  type HookDecisions,
} from '../harness/hook-consent.js';
import {
  disclosedEffectsOf,
  sameDisclosedEffects,
  type DisclosedEffects,
} from './disclosed-effects.js';
import { readInstallMetadata } from './installed-metadata.js';
import { listEnabledPluginNames } from './installed-scanner.js';
import {
  isRuntimeStatePath,
  shippedContentHash,
  TreeHashCache,
  TreeUnhashableError,
} from './lib/content-hash.js';
import { readRunnableDeclarations } from './permission-preview.js';

/** The package types the SDK loads into every session from the global scope. */
export const GLOBALLY_ACTIVATED_TYPES: ReadonlySet<PackageType> = new Set<PackageType>([
  'plugin',
  'skill-pack',
  'adapter',
]);

/** A disclosure that runs nothing, for a package whose preview had none. */
const NOTHING: DisclosedEffects = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
};

/**
 * What activation starts, out of a disclosure: everything but its scheduled
 * jobs, which the SDK never loads. `null` (nothing previewed) starts nothing.
 *
 * @param disclosed - What a person was shown, or `null`.
 * @returns The part of it activation binds to.
 */
export function activationEffectsOf(disclosed: DisclosedEffects | null): DisclosedEffects {
  return { ...(disclosed ?? NOTHING), schedules: [] };
}

/**
 * Where a global plugin, skill-pack or adapter of this name is installed: the
 * directory the SDK loads it from.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param name - The package's directory name.
 */
export function globalPackageDir(dorkHome: string, name: string): string {
  return path.join(dorkHome, 'plugins', name);
}

/**
 * Whether a global plugin, skill-pack or adapter of this name is installed.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param name - The package's directory name.
 */
export function globalPackageExists(dorkHome: string, name: string): Promise<boolean> {
  return access(globalPackageDir(dorkHome, name)).then(
    () => true,
    () => false
  );
}

/** Every installed tree's content hash, re-computed only when the tree was written. */
const installedHashes = new TreeHashCache();

/**
 * The content hash of an installed package, everything but DorkOS's runtime
 * state (`isRuntimeStatePath`): the npm step's `node_modules` is in it,
 * because a server the package starts runs that code too.
 *
 * @param packageDir - The installed package directory.
 * @returns `sha256:<hex>`.
 * @throws {TreeUnhashableError} For a link out of the package or a special file.
 */
export function installedContentHash(packageDir: string): Promise<string> {
  return installedHashes.hash(packageDir, 'installed', { skip: isRuntimeStatePath });
}

/**
 * The stored form of one global-activation decision: `<name>@global-<digest>`,
 * where the digest covers the package's install directory name, what it
 * declares, and the content hash of its installed tree. Any change to any of
 * them makes the entry stop matching.
 *
 * @param name - The package's directory under `<dorkHome>/plugins/`, the name the SDK loads it by.
 * @param effects - What it runs ({@link activationEffectsOf}).
 * @param contentHash - {@link installedContentHash} of the installed tree.
 * @returns The entry as it is stored in the hook-decision lists.
 */
export function globalActivationEntry(
  name: string,
  effects: DisclosedEffects,
  contentHash: string
): string {
  const digest = createHash('sha256')
    .update(
      stableStringify(['global-activation', name, activationEffectsOf(effects), contentHash]),
      'utf8'
    )
    .digest('hex');
  return `${name}${GLOBAL_ACTIVATION_ENTRY_MARKER}${digest}`;
}

/** Whether a stored entry is a global-activation decision for this package. */
function isEntryFor(name: string): (stored: string) => boolean {
  const prefix = `${name}${GLOBAL_ACTIVATION_ENTRY_MARKER}`;
  return (stored) => stored.startsWith(prefix) && !stored.slice(prefix.length).includes('@');
}

/** What {@link readActivationState} found in an installed package. */
export type ActivationReading =
  { effects: DisclosedEffects; contentHash: string } | { unreadable: string[] };

/**
 * Read what an installed package would run if it were loaded, and hash it.
 *
 * @param packageDir - The installed package directory.
 * @returns What it runs and its content hash, or every declaration that could
 *   not be read (and anything whose bytes could not be pinned). A package with
 *   anything unreadable cannot be shown to a person, so it cannot be approved.
 */
export async function readActivationState(packageDir: string): Promise<ActivationReading> {
  const declared = await readRunnableDeclarations(packageDir);
  const unreadable = [
    ...declared.unreadableHooks.map((h) => (h.event ? `${h.path} (${h.event})` : h.path)),
    ...declared.unreadableDeclarations.map((d) => (d.entry ? `${d.path} (${d.entry})` : d.path)),
  ];
  if (unreadable.length > 0) return { unreadable };
  let contentHash: string;
  try {
    contentHash = await installedContentHash(packageDir);
  } catch (err) {
    if (err instanceof TreeUnhashableError) return { unreadable: [err.message] };
    throw err;
  }
  return {
    effects: activationEffectsOf(disclosedEffectsOf({ ...declared, schedules: [] })),
    contentHash,
  };
}

/** Why a global package is left out of every session. */
export type GlobalWithheldReason = 'refused' | 'unasked' | 'unreadable' | 'unreadable-config';

/** One global package left out of every session, and what it would have run. */
export interface WithheldGlobalPlugin {
  /** The package's directory name, the name the SDK would load it by. */
  name: string;
  /** Its installed directory. */
  packageDir: string;
  /** Why it is left out. */
  reason: GlobalWithheldReason;
  /** What it runs, when that could be read. */
  effects?: DisclosedEffects;
  /** Its content hash, when it could be read: what an approval would bind. */
  contentHash?: string;
  /**
   * An earlier approval for this package exists but covers other bytes or
   * programs: it changed since a person approved it.
   */
  changedSinceApproval?: boolean;
  /** The declarations that could not be read, when {@link reason} is `unreadable`. */
  unreadable?: string[];
  /** Why the settings file could not be read, when {@link reason} is `unreadable-config`. */
  configProblem?: string;
}

/** Every global package candidate, split into what loads and what is left out. */
export interface GlobalPluginPartition {
  /** Names to load, in the order the scan found them. */
  activate: string[];
  /** Packages left out, and why. */
  withheld: WithheldGlobalPlugin[];
}

/**
 * Split every globally installed plugin, skill-pack and adapter into what may
 * load into sessions and what is left out.
 *
 * Checked in the order refused → approved → unasked, so a file that somehow
 * holds both answers withholds rather than loads, and everything that runs
 * anything is withheld when the decisions could not be read at all. A package
 * whose directory is gone is skipped: there is nothing to load or to ask about.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param decisions - The stored lists; defaults to the running server's, read
 *   only when a package runs anything.
 * @returns What loads, and what is left out with the reason.
 */
export async function partitionGlobalPlugins(
  dorkHome: string,
  decisions?: HookDecisions
): Promise<GlobalPluginPartition> {
  const partition: GlobalPluginPartition = { activate: [], withheld: [] };
  // Read once, and only when some package runs anything: a machine whose
  // global packages run nothing never needs the settings file to load them.
  let stored: HookDecisions | undefined = decisions;
  const readDecisions = (): HookDecisions => (stored ??= storedHookDecisions());
  for (const name of await listEnabledPluginNames(dorkHome)) {
    const packageDir = globalPackageDir(dorkHome, name);
    if (!(await globalPackageExists(dorkHome, name))) continue;
    const reading = await readActivationState(packageDir);
    if ('unreadable' in reading) {
      partition.withheld.push({
        name,
        packageDir,
        reason: 'unreadable',
        unreadable: reading.unreadable,
      });
      continue;
    }
    const { effects, contentHash } = reading;
    if (!disclosesAnything(effects)) {
      partition.activate.push(name);
      continue;
    }
    const { approved, refused, unreadable } = readDecisions();
    if (unreadable !== undefined) {
      partition.withheld.push({
        name,
        packageDir,
        reason: 'unreadable-config',
        effects,
        contentHash,
        configProblem: unreadable,
      });
      continue;
    }
    const entry = globalActivationEntry(name, effects, contentHash);
    if (refused.includes(entry)) {
      partition.withheld.push({ name, packageDir, reason: 'refused', effects, contentHash });
    } else if (approved.includes(entry)) {
      partition.activate.push(name);
    } else {
      partition.withheld.push({
        name,
        packageDir,
        reason: 'unasked',
        effects,
        contentHash,
        ...(approved.some(isEntryFor(name)) && { changedSinceApproval: true }),
      });
    }
  }
  return partition;
}

/**
 * The names that may load into sessions right now: {@link partitionGlobalPlugins}'s
 * `activate` half. What `refreshActivatedPlugins` hands the SDK.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns Package names to load.
 */
export async function listConsentedPluginNames(dorkHome: string): Promise<string[]> {
  return (await partitionGlobalPlugins(dorkHome)).activate;
}

/**
 * Record that a person allowed this global package, as it is now, to run in
 * every session. Replaces any earlier approval for the package.
 *
 * @param name - The package's directory name.
 * @param effects - What it runs, as the person was shown it.
 * @param contentHash - {@link installedContentHash} of what they approved.
 */
export function recordGlobalActivationApproval(
  name: string,
  effects: DisclosedEffects,
  contentHash: string
): void {
  recordApprovedEntry(
    globalActivationEntry(name, effects, contentHash),
    'approving a global package to run in every session',
    isEntryFor(name)
  );
}

/**
 * Record that a person turned this global package, as it is now, down.
 *
 * @param name - The package's directory name.
 * @param effects - What it runs, as the person was shown it.
 * @param contentHash - {@link installedContentHash} of what they refused.
 */
export function recordGlobalActivationRefusal(
  name: string,
  effects: DisclosedEffects,
  contentHash: string
): void {
  recordRefusedEntry(
    globalActivationEntry(name, effects, contentHash),
    'turning down a global package running in every session'
  );
}

/**
 * Forget every approval for a global package: it was replaced or removed, so
 * no earlier yes may cover whatever is put there next.
 *
 * @param name - The package's directory name.
 */
export function forgetGlobalActivationApprovals(name: string): void {
  forgetApprovedEntries(isEntryFor(name), 'a global package was replaced or removed');
}

/** What a person approved about an install: what it runs and the bytes they were shown. */
export interface ApprovedPackage {
  /** The disclosure they saw. */
  disclosed: DisclosedEffects | null;
  /** The shipped-content hash of the package they saw (`shippedContentHash`). */
  contentHash: string;
}

/** A global or project install that just landed. */
export interface LandedInstall {
  /** Where it landed. */
  installPath: string;
  /** Its package type. */
  type: PackageType;
  /** Whether it is a global install. */
  global: boolean;
}

/**
 * Settles consent after installs and updates land, so a package a person just
 * approved loads without a second card, and nothing anybody else put there
 * rides an old approval. Injected into every surface that installs, updates or
 * removes, so each surface's tests see exactly what it settles.
 */
export interface GlobalConsentRecorder {
  /**
   * An install or update landed. Every earlier approval for the package is
   * forgotten; when `approved` is given (a person saw it), the new copy is
   * recorded as approved, but only if it declares exactly what they were
   * shown and its shipped bytes hash the same as what they were shown.
   */
  settle(install: LandedInstall, approved?: ApprovedPackage): Promise<void>;
  /** A global package was removed: forget its approvals. */
  removed(name: string): void;
}

/** The recorder the server runs with: writes to the hook-decision lists. */
export const globalConsentRecorder: GlobalConsentRecorder = {
  async settle(install, approved) {
    if (!install.global || !GLOBALLY_ACTIVATED_TYPES.has(install.type)) return;
    const name = path.basename(install.installPath);
    forgetGlobalActivationApprovals(name);
    if (!approved) return;
    const reading = await readActivationState(install.installPath);
    if ('unreadable' in reading || !disclosesAnything(reading.effects)) return;
    // What landed must be the bytes the person was shown (which also pins
    // every declaration: they are files among them). Anything else stays held
    // back and asks with a card. The installer already held the install to
    // the disclosure itself before writing anything.
    let shipped: string;
    try {
      shipped = await shippedContentHash(install.installPath);
    } catch {
      return;
    }
    if (shipped !== approved.contentHash) return;
    recordGlobalActivationApproval(name, reading.effects, reading.contentHash);
  },
  removed(name) {
    forgetGlobalActivationApprovals(name);
  },
};
