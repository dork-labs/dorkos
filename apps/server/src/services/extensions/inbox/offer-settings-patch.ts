/**
 * Applying a follow-up offer's settings patch as the person (spec
 * `flow-multiproject` §7.8), split out of the inbox service.
 *
 * @module services/extensions/inbox/offer-settings-patch
 */
import type { ProjectRegistry } from '../../projects/project-registry.js';
import { logger } from '../../../lib/logger.js';
import type { StoredOffer } from './extension-inbox-rows.js';
import { projectSettingsStore } from './extension-project-settings.js';

/** What applying a patch came to: the project's name, or the refusal to answer with. */
export type OfferPatchOutcome =
  { ok: true; name: string } | { ok: false; status: number; code: string; message: string };

/**
 * Apply an offer's settings patch as the person. A project that is gone, outside
 * the boundary or not this extension's is the state it met (`409
 * offer_project_unavailable`); a lookup or store that threw is the server's own
 * fault (`500 offer_failed`), logged here.
 *
 * @param deps - The project registry and the DorkOS data directory.
 * @param extensionId - The extension the offer came from.
 * @param patch - The offer's settings patch.
 * @returns The outcome.
 */
export async function applyOfferSettingsPatch(
  deps: { projects: Pick<ProjectRegistry, 'resolveWithin' | 'listForExtension'>; dorkHome: string },
  extensionId: string,
  patch: NonNullable<StoredOffer['settingsPatch']>
): Promise<OfferPatchOutcome> {
  const gone: OfferPatchOutcome = {
    ok: false,
    status: 409,
    code: 'offer_project_unavailable',
    message: 'That project is no longer available.',
  };
  try {
    const resolved = await deps.projects.resolveWithin(patch.project, extensionId);
    if (!resolved || resolved === 'outside') return gone;
    const allowed = await deps.projects.listForExtension(extensionId);
    if (!allowed.some((p) => p.root === resolved.root)) return gone;
    await projectSettingsStore(deps.dorkHome).merge(
      extensionId,
      resolved.root,
      patch.patch,
      'person'
    );
    return { ok: true, name: resolved.name };
  } catch (err) {
    logger.warn(`[ext:${extensionId}] could not apply an offer's settings`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 500,
      code: 'offer_failed',
      message: "Couldn't change that. Try again.",
    };
  }
}
