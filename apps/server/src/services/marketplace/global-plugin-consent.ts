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
 * check anything, so a package reinstalled by an agent over HTTP ran in the
 * next session with nobody having seen it.
 *
 * ## The threat boundary
 *
 * An approval binds what ARRIVES through DorkOS's install and update channel:
 * code fetched from a source, by the app, the terminal, or an agent's MCP or
 * HTTP call. It does not police a local process editing files on disk.
 * Anything running as the person, an agent's shell included, can already write
 * `~/.claude/settings.json` hooks or any script it likes, so re-hashing the
 * install folder on every turn would buy no real boundary.
 *
 * ## What a person approves
 *
 * One package's install EVENT and the programs it declares. The installer
 * records the landed package's content hash in its install metadata
 * (`lib/content-hash.ts` `packageContentHash`, the same hash the preview
 * showed), and an approval binds that recorded hash plus the declarations
 * read at refresh ({@link activationEffectsOf}, the same reader the install
 * preview uses). A new install or update records a new hash, so it is a
 * package nobody approved until a person does. Scheduled jobs are left out of
 * the declarations on purpose: the SDK does not load them, and each arrives
 * parked at `pending_approval` behind a gate of its own. A package that
 * declares nothing that runs on its own loads without being asked about.
 *
 * Two kinds of package have no install event to bind:
 *
 * - One installed before the hash was recorded (`unrecorded`). It is held
 *   back with a note that leads to the Review card, which shows it as it is
 *   now; a decision records that hash in its metadata, as an install would.
 * - A LINKED install: `~/.dork/plugins/<name>` is a symbolic link to a
 *   developer's working copy, which DorkOS never fetched and never updates.
 *   It is approved by NAME AND PATH (its real path), and its card and row say
 *   plainly that it runs whatever is in that folder: pinning bytes a developer
 *   edits all day would only teach them to click yes.
 *
 * A declaration that points into a path the hash leaves out (the package's
 * saved data or secrets, the install records) could run bytes nobody ever
 * saw, so such a package cannot be approved: it is held back as unreadable.
 *
 * ## When it is checked
 *
 * When the runtime builds its plugin list: at boot and after every
 * marketplace change. Cheap, because nothing is hashed: the recorded hash is
 * read from the install metadata. Anything the refresh cannot read about one
 * package holds that package back; a refresh that fails as a whole loads no
 * global package at all.
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
 * Refused, never asked, unrecorded, unreadable declarations, or a settings
 * file that could not be read: it is left out. The SDK has no way to load a
 * plugin without its hooks (`skipMcpDiscovery` drops only `.mcp.json`), so
 * withholding leaves the whole package out, its skills and commands included.
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
 * (the caller sends back the disclosure and content hash it was shown, and
 * the hash the installer recorded must be the same), a granted approval card
 * (an agent's install or update, or the card `ask-withheld-global-plugins.ts`
 * raises for a held-back package), or `dorkos marketplace held-back --allow`.
 * Never for a caller who merely may skip a card (`preApproved`).
 *
 * @module services/marketplace/global-plugin-consent
 */
import { createHash } from 'node:crypto';
import { access, lstat, realpath } from 'node:fs/promises';
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
import { disclosedEffectsOf, type DisclosedEffects } from './disclosed-effects.js';
import { listEnabledPluginNames } from './installed-scanner.js';
import { readInstallMetadata, writeInstallMetadata } from './installed-metadata.js';
import { packageContentHash, RUNTIME_STATE_PATHS } from './lib/content-hash.js';
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

/** The prefix of a {@link ActivationSubject}'s binding for a linked install. */
const LINKED_PREFIX = 'linked:';

/**
 * What an approval of one global package is bound to, besides its
 * declarations: the content hash its install recorded, or, for a linked
 * install, the folder it runs from.
 */
export type ActivationSubject =
  { kind: 'installed'; contentHash: string } | { kind: 'linked'; path: string };

/**
 * A subject as one opaque string: `sha256:<hex>` for an install, or
 * `linked:<real path>` for a linked one. What a decision made elsewhere (the
 * terminal) sends back to say what it was shown.
 *
 * @param subject - The subject.
 */
export function bindingOf(subject: ActivationSubject): string {
  return subject.kind === 'installed' ? subject.contentHash : `${LINKED_PREFIX}${subject.path}`;
}

/**
 * The stored form of one global-activation decision: `<name>@global-<digest>`,
 * where the digest covers the package's install directory name, what it
 * declares, and what it is bound to ({@link bindingOf}). Any change to any of
 * them makes the entry stop matching.
 *
 * @param name - The package's directory under `<dorkHome>/plugins/`, the name the SDK loads it by.
 * @param effects - What it runs ({@link activationEffectsOf}).
 * @param bindsTo - {@link bindingOf} its subject.
 * @returns The entry as it is stored in the hook-decision lists.
 */
export function globalActivationEntry(
  name: string,
  effects: DisclosedEffects,
  bindsTo: string
): string {
  const digest = createHash('sha256')
    .update(
      stableStringify(['global-activation', name, activationEffectsOf(effects), bindsTo]),
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
  | {
      effects: DisclosedEffects;
      /** What an approval binds, or `null` when its install recorded no hash. */
      subject: ActivationSubject | null;
      /** Whether it has an install metadata file a review can record a hash in. */
      hasMetadata: boolean;
    }
  | { unreadable: string[] };

/** Every command, argument and executable a disclosure would start. */
function commandsOf(effects: DisclosedEffects): string[] {
  return [
    ...effects.hooks.map((hook) => hook.command),
    ...effects.mcpServers.flatMap((server) => [server.command ?? '', ...server.args]),
    ...effects.lspServers.flatMap((server) => [server.command, ...server.args]),
    ...effects.monitors.flatMap((monitor) => [monitor.command, ...monitor.args]),
    ...effects.executables,
  ];
}

/**
 * One pattern per runtime-state path, matched as whole path segments (so
 * `.dork/data` catches `.dork/data/run.sh` but not `.dork/database.sh`). The
 * paths hold no regex character but the dot.
 */
const UNCHECKED_PATH_PATTERNS = RUNTIME_STATE_PATHS.map(
  (unchecked) => new RegExp(`(^|[^\\w.-])${unchecked.replaceAll('.', '\\.')}(?=$|[^\\w.-])`)
);

/**
 * The declarations that point into a path the content hash leaves out
 * (`lib/content-hash.ts` `RUNTIME_STATE_PATHS`): a program there could be
 * anything, and nobody would ever have been shown it.
 *
 * @param effects - What a package declares.
 * @returns One line per such declaration, empty when there are none.
 */
export function declarationsIntoUncheckedPaths(effects: DisclosedEffects): string[] {
  return commandsOf(effects)
    .filter((command) => {
      // `a//b` and `a/./b` name `a/b`; `..` needs no folding, the segment
      // after it is still matched whole.
      const posix = command
        .replaceAll('\\', '/')
        .replace(/\/+/g, '/')
        .replace(/\/\.(?=\/)/g, '');
      return UNCHECKED_PATH_PATTERNS.some((pattern) => pattern.test(posix));
    })
    .map((command) => `${command} (runs from a folder DorkOS never checks)`);
}

/**
 * Read what an installed package would run if it were loaded, and what an
 * approval of it is bound to. Hashes nothing: the hash is the one its install
 * recorded.
 *
 * @param packageDir - The installed package directory.
 * @returns What it runs and its subject, or every declaration that could not
 *   be read or that points somewhere the hash does not cover. A package with
 *   anything unreadable cannot be shown to a person, so it cannot be approved.
 */
export async function readActivationState(packageDir: string): Promise<ActivationReading> {
  const declared = await readRunnableDeclarations(packageDir);
  const unreadable = [
    ...declared.unreadableHooks.map((h) => (h.event ? `${h.path} (${h.event})` : h.path)),
    ...declared.unreadableDeclarations.map((d) => (d.entry ? `${d.path} (${d.entry})` : d.path)),
  ];
  if (unreadable.length > 0) return { unreadable };
  const effects = activationEffectsOf(disclosedEffectsOf({ ...declared, schedules: [] }));
  const unchecked = declarationsIntoUncheckedPaths(effects);
  if (unchecked.length > 0) return { unreadable: unchecked };
  if ((await lstat(packageDir)).isSymbolicLink()) {
    return {
      effects,
      subject: { kind: 'linked', path: await realpath(packageDir) },
      hasMetadata: false,
    };
  }
  const metadata = await readInstallMetadata(packageDir);
  return {
    effects,
    subject: metadata?.contentHash
      ? { kind: 'installed', contentHash: metadata.contentHash }
      : null,
    hasMetadata: metadata !== null,
  };
}

/** Why a global package is left out of every session. */
export type GlobalWithheldReason =
  'refused' | 'unasked' | 'unrecorded' | 'unreadable' | 'unreadable-config';

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
  /**
   * What an approval binds ({@link bindingOf}), when there is one: absent for
   * an `unrecorded` package, whose review hashes it as it is now.
   */
  subject?: ActivationSubject;
  /** For `unrecorded`: whether it has a metadata file a review can record in. */
  hasMetadata?: boolean;
  /**
   * An earlier approval for this package exists but covers another install
   * or other programs: it changed since a person approved it.
   */
  changedSinceApproval?: boolean;
  /** What could not be read, when {@link reason} is `unreadable`. */
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
 * whose directory is gone is skipped: there is nothing to load or to ask
 * about. Anything that goes wrong reading ONE package holds that package back
 * as unreadable; a failure listing the packages at all throws, and the caller
 * loads none.
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
    let reading: ActivationReading;
    try {
      reading = await readActivationState(packageDir);
    } catch (err) {
      reading = { unreadable: [err instanceof Error ? err.message : String(err)] };
    }
    if ('unreadable' in reading) {
      partition.withheld.push({
        name,
        packageDir,
        reason: 'unreadable',
        unreadable: reading.unreadable,
      });
      continue;
    }
    const { effects, subject, hasMetadata } = reading;
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
        ...(subject && { subject }),
        configProblem: unreadable,
      });
      continue;
    }
    if (subject === null) {
      partition.withheld.push({ name, packageDir, reason: 'unrecorded', effects, hasMetadata });
      continue;
    }
    const entry = globalActivationEntry(name, effects, bindingOf(subject));
    if (refused.includes(entry)) {
      partition.withheld.push({ name, packageDir, reason: 'refused', effects, subject });
    } else if (approved.includes(entry)) {
      partition.activate.push(name);
    } else {
      partition.withheld.push({
        name,
        packageDir,
        reason: 'unasked',
        effects,
        subject,
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
 * @param bindsTo - {@link bindingOf} what they approved.
 */
export function recordGlobalActivationApproval(
  name: string,
  effects: DisclosedEffects,
  bindsTo: string
): void {
  recordApprovedEntry(
    globalActivationEntry(name, effects, bindsTo),
    'approving a global package to run in every session',
    isEntryFor(name)
  );
}

/**
 * Record that a person turned this global package, as it is now, down.
 *
 * @param name - The package's directory name.
 * @param effects - What it runs, as the person was shown it.
 * @param bindsTo - {@link bindingOf} what they refused.
 */
export function recordGlobalActivationRefusal(
  name: string,
  effects: DisclosedEffects,
  bindsTo: string
): void {
  recordRefusedEntry(
    globalActivationEntry(name, effects, bindsTo),
    'turning down a global package running in every session'
  );
}

/**
 * What a decision about a held-back package binds, for showing it to a person:
 * its recorded subject, or for an `unrecorded` package with a metadata file,
 * its content hash as it is now. `undefined` when it cannot be decided.
 *
 * @param plugin - The held-back package.
 */
export async function reviewBindingOf(plugin: WithheldGlobalPlugin): Promise<string | undefined> {
  if (plugin.subject) return bindingOf(plugin.subject);
  if (plugin.reason !== 'unrecorded' || !plugin.hasMetadata) return undefined;
  try {
    return await packageContentHash(plugin.packageDir);
  } catch {
    return undefined;
  }
}

/**
 * Record a person's decision about a held-back package, but only if it is
 * still exactly what they were shown: the same declarations and the same
 * {@link reviewBindingOf}. For an `unrecorded` package the hash they reviewed
 * is first written into its install metadata, as an install would have.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param name - The package's directory name.
 * @param shown - What the person was shown: its declarations and binding.
 * @param decision - `allow` or `refuse`.
 * @returns False when it changed since, or is not held back: nothing recorded.
 */
export async function recordHeldBackDecision(
  dorkHome: string,
  name: string,
  shown: { effects: DisclosedEffects; bindsTo: string },
  decision: 'allow' | 'refuse'
): Promise<boolean> {
  const { withheld } = await partitionGlobalPlugins(dorkHome);
  const plugin = withheld.find((w) => w.name === name);
  if (!plugin?.effects || plugin.reason === 'unreadable-config') return false;
  if (stableStringify(plugin.effects) !== stableStringify(shown.effects)) return false;
  if ((await reviewBindingOf(plugin)) !== shown.bindsTo) return false;
  if (plugin.reason === 'unrecorded') {
    const metadata = await readInstallMetadata(plugin.packageDir);
    if (!metadata) return false;
    await writeInstallMetadata(plugin.packageDir, { ...metadata, contentHash: shown.bindsTo });
  }
  if (decision === 'allow') recordGlobalActivationApproval(name, shown.effects, shown.bindsTo);
  else recordGlobalActivationRefusal(name, shown.effects, shown.bindsTo);
  return true;
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
  /** The content hash of the package they saw (`packageContentHash` of the staged copy). */
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
   * forgotten; when `approved` is given (a person saw it), the new install is
   * recorded as approved, but only if the content hash its install recorded is
   * the one they were shown.
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
    // What landed must be the bytes the person was shown, as the installer
    // recorded them at the install event (which also pins every declaration:
    // they are files among them). Anything else stays held back and asks with
    // a card. The installer already held the install to the disclosure itself
    // before writing anything.
    if (reading.subject?.kind !== 'installed') return;
    if (reading.subject.contentHash !== approved.contentHash) return;
    recordGlobalActivationApproval(name, reading.effects, reading.subject.contentHash);
  },
  removed(name) {
    forgetGlobalActivationApprovals(name);
  },
};
