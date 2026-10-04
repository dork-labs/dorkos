/**
 * The link-time yes for what a dev-linked folder runs on its own (DOR-2696
 * task 2.2, spec `marketplace-dev-link` §4).
 *
 * The approval card for a link lists every hook, server and program the
 * folder declares (`describePlan`), and the yes is bound to that text: a
 * folder that describes differently by the time the yes is used is refused
 * (`dev_link_changed`). This module records that same yes where each surface
 * that would otherwise ask looks for it, and only for what the card showed:
 *
 * - **Global scope**: one global-activation approval
 *   (`global-plugin-consent.ts`), bound to `linked:<folder>` and to exactly the
 *   declarations on the card, so the link loads into every session without a
 *   held-back card. Any later change to what it declares is a different digest
 *   and asks through the held-back card; editing a script a hook runs does not.
 * - **Project scope**: one hook approval (`harness/hook-consent.ts`) for the
 *   hooks Harness Sync will project, recorded only when every one of them was
 *   on the card. A hook added later asks through the hook card.
 *
 * Nothing is recorded for a folder whose declarations could not all be read,
 * or that points a program into a folder the content hash never covers: the
 * card could not show those, so no yes can cover them, and global consent
 * holds such a package back whatever is stored.
 *
 * Unlink undoes exactly what link did. The global entries the installed copy
 * had are captured before they are replaced and put back verbatim when that
 * copy comes back (they bind its unchanged content hash). Hook approvals the
 * link added are listed on its record and removed; one that was already there
 * (the installed copy's, for the same hooks in the same project) was never the
 * link's and stays.
 *
 * @module services/marketplace/dev-links/consent
 */
import path from 'node:path';
import {
  projectedHooks,
  rewritePluginTokens,
  scanInstalledPlugins,
  type ProjectedHook,
} from '@dorkos/harness';
import {
  disclosesAnything,
  type DevLinkPreview,
  type DevLinkRecord,
} from '@dorkos/shared/marketplace-schemas';
import {
  forgetApprovedEntries,
  hookApprovalEntry,
  recordApprovedEntry,
  storedHookDecisions,
} from '../../harness/hook-consent.js';
import {
  activationEffectsOf,
  bindingOf,
  declarationsIntoUncheckedPaths,
  globalActivationEntry,
  isGlobalActivationEntryFor,
} from '../consent/global-plugin-consent.js';

/** The operator-only decision lists a dev link reads and writes (`harness.approvedHooks`). */
export interface DevLinkConsentStore {
  /** Every stored yes. */
  approved(): readonly string[];
  /**
   * Store one yes, removing in the same write every earlier yes `replacing`
   * matches (and any matching no).
   */
  approve(entry: string, replacing?: (stored: string) => boolean): void;
  /** Remove every stored yes `matches` matches, leaving every no in place. */
  forget(matches: (stored: string) => boolean): void;
}

/** The store the server runs with: the hook-decision lists in `config.json`. */
export const hookDecisionConsentStore: DevLinkConsentStore = {
  approved: () => storedHookDecisions().approved,
  approve: (entry, replacing) =>
    recordApprovedEntry(entry, 'linking a folder a person approved', replacing),
  forget: (matches) => forgetApprovedEntries(matches, 'unlinking a folder'),
};

/** What a link will record, worked out before anything is written. */
export interface LinkConsentPlan {
  /**
   * The global-activation entry the link records, bound to its folder and the
   * card's declarations. Absent for a project link, a folder that runs nothing
   * on its own, or one whose declarations the card could not show in full.
   */
  globalEntry?: string;
  /** The installed copy's stored global entries this one replaces, put back on unlink. */
  capturedGlobal: string[];
  /** Hook approvals the link adds; ones already stored are not the link's. */
  grantedHooks: string[];
}

/** What {@link planLinkConsent} needs to know about the link. */
export interface LinkConsentInput {
  /** What the card showed. */
  preview: DevLinkPreview;
  /** The record about to be written (the slot, folder and scope). */
  record: DevLinkRecord;
  /** Whether every declaration in the folder could be read (nothing the card left out). */
  declarationsReadable: boolean;
  /** The resolved DorkOS data directory. */
  dorkHome: string;
}

/**
 * Work out what the link-time yes records, reading but writing nothing.
 *
 * @param store - The decision lists.
 * @param input - The card and the record.
 * @returns The entries to record and the ones they replace.
 */
export function planLinkConsent(
  store: DevLinkConsentStore,
  input: LinkConsentInput
): LinkConsentPlan {
  const { preview, record } = input;
  const plan: LinkConsentPlan = { capturedGlobal: [], grantedHooks: [] };
  const effects = activationEffectsOf(preview.effects);
  const showable =
    input.declarationsReadable && declarationsIntoUncheckedPaths(effects).length === 0;
  if (record.scope === 'global') {
    // Captured whatever happens next: the yes below replaces them, and unlink
    // puts them back for the installed copy.
    plan.capturedGlobal = store.approved().filter(isGlobalActivationEntryFor(record.name));
    if (showable && disclosesAnything(effects)) {
      plan.globalEntry = globalActivationEntry(
        record.name,
        effects,
        bindingOf({ kind: 'linked', path: record.target })
      );
    }
    return plan;
  }
  if (!showable || record.projectPath === undefined) return plan;
  const hooks = projectHooksShownOnCard(input, record.projectPath);
  if (hooks === null || hooks.length === 0) return plan;
  const entry = hookApprovalEntry({
    projectPath: record.projectPath,
    packageName: record.name,
    hooks,
  });
  if (!store.approved().includes(entry)) plan.grantedHooks = [entry];
  return plan;
}

/**
 * Record what {@link planLinkConsent} worked out.
 *
 * @param store - The decision lists.
 * @param record - The link's record.
 * @param plan - The plan.
 */
export function applyLinkConsent(
  store: DevLinkConsentStore,
  record: DevLinkRecord,
  plan: LinkConsentPlan
): void {
  if (plan.globalEntry !== undefined) {
    store.approve(plan.globalEntry, isGlobalActivationEntryFor(record.name));
  } else if (plan.capturedGlobal.length > 0) {
    // The installed copy's approvals bind bytes that are not in the slot any
    // more; nothing may ride them while the folder is linked.
    store.forget(isGlobalActivationEntryFor(record.name));
  }
  for (const entry of plan.grantedHooks) store.approve(entry);
}

/**
 * Take back the link's own consent, and put the installed copy's back when it
 * returned to the slot.
 *
 * @param store - The decision lists.
 * @param record - The dev link being removed, as recorded.
 * @param installedBack - Whether the set-aside installed copy is back in the slot.
 */
export function forgetLinkConsent(
  store: DevLinkConsentStore,
  record: DevLinkRecord,
  installedBack: boolean
): void {
  const granted = new Set(record.grantedHooks ?? []);
  if (granted.size > 0) store.forget((stored) => granted.has(stored));
  if (record.scope !== 'global') return;
  // Every global entry for this name while the link was in place was the
  // link's: the link-time yes, or a later held-back card about the folder.
  // Only one package can sit in a global slot, so none is anybody else's.
  store.forget(isGlobalActivationEntryFor(record.name));
  if (!installedBack) return;
  for (const entry of record.restoreApprovals?.globalActivation ?? []) store.approve(entry);
}

/** One hook's identity, for comparing what the card showed with what will project. */
function hookKey(hook: ProjectedHook): string {
  return JSON.stringify([hook.event, hook.matcher ?? null, hook.command]);
}

/**
 * The hooks Harness Sync will project for the link into its project, when
 * every one of them was on the card; `null` when one was not.
 *
 * Read off the link itself (the same scan and the same projection the sync
 * runs), then held against the card: each card hook's command is resolved the
 * way the projector resolves `${CLAUDE_PLUGIN_ROOT}`, under the same install
 * directory. A folder edited after the card was checked projects a hook the
 * card did not show, and then nothing is recorded: the hook card asks.
 */
function projectHooksShownOnCard(
  input: LinkConsentInput,
  projectPath: string
): ProjectedHook[] | null {
  const { preview, record } = input;
  const installDir = path.join(projectPath, '.dork', 'plugins', record.name);
  const shown = new Set(
    (preview.effects?.hooks ?? [])
      .filter((hook) => hook.source === null)
      .map((hook) =>
        hookKey({
          event: hook.event,
          ...(hook.matcher !== null && hook.matcher !== '' && { matcher: hook.matcher }),
          command: rewritePluginTokens(hook.command, installDir),
        })
      )
  );
  const plugins = scanInstalledPlugins({
    projectRoot: projectPath,
    dorkHome: input.dorkHome,
    devLinks: [record],
  }).filter((plugin) => plugin.location.scope === 'project' && plugin.name === record.name);
  const [projected] = projectedHooks(plugins, projectPath);
  const hooks = projected?.hooks ?? [];
  return hooks.every((hook) => shown.has(hookKey(hook))) ? hooks : null;
}
