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
 * One package's exact set of programs ({@link activationEffectsOf}), read from
 * the installed files by the same reader the install preview uses
 * (`readRunnableDeclarations`). Scheduled jobs are left out on purpose: the SDK
 * does not load them, and each arrives parked at `pending_approval` behind a
 * gate of its own. A package that runs nothing on its own loads without being
 * asked about.
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
 * Only where a person approved exactly that set: the app's install or update
 * (the caller sends back what it was shown and the server held the install to
 * it), a granted approval card (an agent's update or install, or the card
 * `ask-withheld-global-plugins.ts` raises for a withheld package). Never for a
 * caller who merely may skip a card (`preApproved`), and never for an agent's
 * install over HTTP: those load only after a person says yes to that card.
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
  GLOBAL_ACTIVATION_ENTRY_MARKER,
  recordApprovedEntry,
  recordRefusedEntry,
  storedHookDecisions,
  type HookDecisions,
} from '../harness/hook-consent.js';
import { disclosedEffectsOf, type DisclosedEffects } from './disclosed-effects.js';
import { listEnabledPluginNames } from './installed-scanner.js';
import { readRunnableDeclarations } from './permission-preview.js';
import type { ApprovableUpdate } from './flows/update-installed.js';

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
 * The stored form of one global-activation decision: `<name>@global-<digest>`,
 * where the digest covers the package's install directory name and exactly what
 * it runs. Any change to either makes the entry stop matching, so an update or
 * an edit that changes what runs is asked about again.
 *
 * @param name - The package's directory under `<dorkHome>/plugins/`, the name the SDK loads it by.
 * @param effects - What it runs ({@link activationEffectsOf}).
 * @returns The entry as it is stored in the hook-decision lists.
 */
export function globalActivationEntry(name: string, effects: DisclosedEffects): string {
  const digest = createHash('sha256')
    .update(stableStringify(['global-activation', name, activationEffectsOf(effects)]), 'utf8')
    .digest('hex');
  return `${name}${GLOBAL_ACTIVATION_ENTRY_MARKER}${digest}`;
}

/** What {@link readActivationEffects} found in an installed package. */
export type ActivationReading = { effects: DisclosedEffects } | { unreadable: string[] };

/**
 * Read what an installed package would run if it were loaded.
 *
 * @param packageDir - The installed package directory.
 * @returns What it runs, or every declaration that could not be read. A package
 *   with anything unreadable cannot be shown to a person, so it cannot be approved.
 */
export async function readActivationEffects(packageDir: string): Promise<ActivationReading> {
  const declared = await readRunnableDeclarations(packageDir);
  const unreadable = [
    ...declared.unreadableHooks.map((h) => (h.event ? `${h.path} (${h.event})` : h.path)),
    ...declared.unreadableDeclarations.map((d) => (d.entry ? `${d.path} (${d.entry})` : d.path)),
  ];
  if (unreadable.length > 0) return { unreadable };
  return { effects: activationEffectsOf(disclosedEffectsOf({ ...declared, schedules: [] })) };
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
    const packageDir = path.join(dorkHome, 'plugins', name);
    try {
      await access(packageDir);
    } catch {
      continue;
    }
    const reading = await readActivationEffects(packageDir);
    if ('unreadable' in reading) {
      partition.withheld.push({
        name,
        packageDir,
        reason: 'unreadable',
        unreadable: reading.unreadable,
      });
      continue;
    }
    const { effects } = reading;
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
        configProblem: unreadable,
      });
      continue;
    }
    const entry = globalActivationEntry(name, effects);
    if (refused.includes(entry)) {
      partition.withheld.push({ name, packageDir, reason: 'refused', effects });
    } else if (approved.includes(entry)) {
      partition.activate.push(name);
    } else {
      partition.withheld.push({ name, packageDir, reason: 'unasked', effects });
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
 * Record that a person allowed this global package to run exactly these programs.
 *
 * @param name - The package's directory name.
 * @param effects - What it runs, as the person was shown it.
 */
export function recordGlobalActivationApproval(name: string, effects: DisclosedEffects): void {
  recordApprovedEntry(
    globalActivationEntry(name, effects),
    'approving a global package to run in every session'
  );
}

/**
 * Record that a person turned this global package's programs down.
 *
 * @param name - The package's directory name.
 * @param effects - What it runs, as the person was shown it.
 */
export function recordGlobalActivationRefusal(name: string, effects: DisclosedEffects): void {
  recordRefusedEntry(
    globalActivationEntry(name, effects),
    'turning down a global package running in every session'
  );
}

/**
 * Records a person's approval where one was given, so a package they just
 * approved is not withheld and asked about a second time. Injected into the
 * surfaces that apply or install, so each surface's tests can see exactly what
 * it records.
 */
export interface GlobalConsentRecorder {
  /**
   * A person approved these reinstalls, each with what its new version runs.
   * Only global installations of a type the SDK loads are recorded.
   */
  approveUpdates(updates: readonly ApprovableUpdate[]): void;
  /**
   * A person approved installing this package with this disclosure, and the
   * install was held to it. Only a global install of a type the SDK loads is
   * recorded.
   */
  approveInstall(
    install: { installPath: string; type: PackageType; global: boolean },
    disclosed: DisclosedEffects | null
  ): void;
}

/** The recorder the server runs with: writes to the hook-decision lists. */
export const globalConsentRecorder: GlobalConsentRecorder = {
  approveUpdates(updates) {
    for (const update of updates) {
      if (update.scope !== 'global') continue;
      recordIfItRuns(update.installPath, update.type, update.disclosed);
    }
  },
  approveInstall(install, disclosed) {
    if (!install.global) return;
    recordIfItRuns(install.installPath, install.type, disclosed);
  },
};

/**
 * Record a yes for a global package of a type the SDK loads, when it runs
 * anything. A package that runs nothing loads without a decision, so storing
 * one would only be noise in the list a person reads.
 */
function recordIfItRuns(
  installPath: string,
  type: PackageType,
  disclosed: DisclosedEffects | null
): void {
  if (!GLOBALLY_ACTIVATED_TYPES.has(type)) return;
  const effects = activationEffectsOf(disclosed);
  if (!disclosesAnything(effects)) return;
  recordGlobalActivationApproval(path.basename(installPath), effects);
}
