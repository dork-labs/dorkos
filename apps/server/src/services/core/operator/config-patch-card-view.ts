/**
 * The `config_patch` card's hooks, bound to the config as stored when the card
 * is raised (DOR-4775 PR 2), so each line reads old → new.
 *
 * `config-patch-card.ts` stays pure; this is the one place that reads the store
 * for it. The approval still binds to the patch alone: the old values are what
 * the person sees, never what the write uses (`applyConfigPatch` merges onto the
 * file as it is when they say yes).
 *
 * @module services/core/operator/config-patch-card-view
 */
import { configManager } from '../config-manager.js';
import {
  configPatchCardFits,
  describePatchDetail,
  describePatchSentence,
} from './config-patch-card.js';

/**
 * The config as stored now, or `undefined` when there is none to read: the
 * store is set up at boot, and a card raised before that (or in a harness that
 * never sets it up) shows the new values only rather than failing to ask.
 */
function storedConfig(): unknown {
  try {
    return configManager.getAll();
  } catch {
    return undefined;
  }
}

/** The patch a `config_patch` call carries. */
function patchOf(input: unknown): unknown {
  return (input as { patch?: unknown }).patch;
}

/**
 * The card fields `operator.config_patch` declares: its own sentence, and the
 * detail listing every setting old → new, riskiest first.
 */
export const CONFIG_PATCH_CARD = {
  // The area rule wants fields declared; the sentence below replaces them.
  approvalDisplayFields: ['patch'],
  approvalSentence: (input: unknown) => describePatchSentence(patchOf(input)),
  approvalViewDetail: (input: unknown) => describePatchDetail(patchOf(input), storedConfig()),
} as const;

/**
 * Whether the card can list every setting a patch changes, old → new, against
 * the config as stored now. `config_patch` refuses a patch for which this is
 * false before any card is made.
 *
 * @param patch - The patch the call carries.
 */
export function configPatchFitsStoredCard(patch: unknown): boolean {
  return configPatchCardFits(patch, storedConfig());
}
