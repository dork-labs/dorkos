/**
 * The routes a PERSON uses to trust, or stop trusting, a code source (spec
 * `flow-multiproject` §9.3, V9, N11, D14).
 *
 * Trusting code from a source not yet trusted is one of the three asks only a
 * person can answer, so both writes run the same person bar as approving an
 * extension (`extensions-person-bar.ts`): a caller naming itself an agent is
 * refused in every posture, and a signed-in person is required when login is
 * on. They are core UI endpoints only — the bell's one-time offer line and
 * Settings → Extensions call them — and no `ExtensionAPI` member or MCP tool
 * reaches them. The residual is the one invariant 9 names: with login off a
 * local caller that sends no agent header passes, and an approved extension's
 * own browser code shares the app page, so it could `fetch` these too.
 *
 * @module routes/extensions-trusted-sources
 */
import type { Router } from 'express';
import { TrustedSourceRequestSchema } from '@dorkos/shared/extension-approval-schemas';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { normalizeTrustedSource } from '../services/marketplace/lib/trusted-source.js';
import { logger } from '../lib/logger.js';
import { configManager } from '../services/core/config-manager.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** The code every refusal to change trusted sources carries. */
export const TRUSTED_SOURCE_PERSON_ONLY_CODE = 'trusted_source_person_only';

/** What the trusted-source routes say when the bar refuses them. */
const TRUST_BAR: PersonBarCopy = {
  error: 'Only a person can choose which sources DorkOS trusts',
  code: TRUSTED_SOURCE_PERSON_ONLY_CODE,
  subject: 'which code sources DorkOS trusts',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Trusting a source lets its extensions run without asking, so only a person in their ` +
    `own copy of the app can do it.`,
  agent:
    `DorkOS changed nothing. Trusting a source lets every extension from it run without ` +
    `asking, and that is a decision only a person makes. Ask the person to turn the ` +
    `extension on in DorkOS; the app offers to trust its source right after.`,
};

/**
 * Mount the trusted-source routes onto the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - The extension manager, which owns the write.
 */
export function registerTrustedSourceRoutes(
  router: Router,
  extensionManager: ExtensionManager
): void {
  // GET /api/extensions/trusted-sources -- The sources a person trusts. A read
  // of `owner/repo` names only, so it carries no bar.
  router.get('/trusted-sources', (_req, res) => {
    const sources = configManager.get('extensions').trustedSources ?? [];
    return res.json({ sources });
  });

  // POST /api/extensions/trusted-sources -- "Yes" on "Next time, trust
  // everything from <source>?". Only a source some installed copy provably
  // comes from can be trusted: trust is granted once per PROVEN source.
  router.post('/trusted-sources', async (req, res) => {
    try {
      if (refuseIfNotAPerson(req, res, TRUST_BAR)) return undefined;
      const body = TrustedSourceRequestSchema.safeParse(req.body ?? {});
      const source = body.success ? normalizeTrustedSource(body.data.source) : null;
      if (!source) {
        return res.status(400).json({ error: 'Send the source to trust, like owner/repo' });
      }

      const result = await extensionManager.trustSource(source);
      if (result === 'unproven') {
        return res.status(409).json({
          error: `DorkOS hasn't installed anything from ${source}, so there is nothing to trust yet.`,
          code: 'unproven_source',
        });
      }
      if (result === 'added') {
        const activityService = req.app.locals.activityService as ActivityService | undefined;
        await activityService?.emit({
          ...readActivityActor(req, res),
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: source,
          resourceLabel: source,
          summary: `Trusted every extension from ${source}`,
        });
      }
      return res.json({ sources: configManager.get('extensions').trustedSources ?? [] });
    } catch (err) {
      logger.error('[Extensions] Failed to trust a source', err);
      return res.status(500).json({ error: 'Failed to trust that source' });
    }
  });

  // DELETE /api/extensions/trusted-sources -- "Stop trusting". Extensions
  // already turned on stay on; new copies from the source ask again.
  router.delete('/trusted-sources', async (req, res) => {
    try {
      if (refuseIfNotAPerson(req, res, TRUST_BAR)) return undefined;
      const body = TrustedSourceRequestSchema.safeParse(req.body ?? {});
      const source = body.success ? normalizeTrustedSource(body.data.source) : null;
      if (!source) {
        return res.status(400).json({ error: 'Send the source to stop trusting, like owner/repo' });
      }

      const removed = await extensionManager.untrustSource(source);
      if (!removed) {
        return res.status(404).json({ error: `${source} isn't a trusted source` });
      }
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      await activityService?.emit({
        ...readActivityActor(req, res),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: source,
        resourceLabel: source,
        summary: `Stopped trusting every extension from ${source}`,
      });
      return res.json({ sources: configManager.get('extensions').trustedSources ?? [] });
    } catch (err) {
      logger.error('[Extensions] Failed to stop trusting a source', err);
      return res.status(500).json({ error: 'Failed to stop trusting that source' });
    }
  });
}
