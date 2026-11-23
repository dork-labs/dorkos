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
import type { Context, Hono } from 'hono';
import { TrustedSourceRequestSchema } from '@dorkos/shared/extension-approval-schemas';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { normalizeTrustedSource } from '../services/marketplace/lib/trusted-source.js';
import { logger } from '../lib/logger.js';
import { configManager } from '../services/core/config-manager.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** What the trusted-source routes say when the bar refuses them. */
const TRUST_BAR: PersonBarCopy = {
  code: 'person_only',
  subject: 'which code sources DorkOS trusts',
  crossSite: (origin) => `Nothing changed. ${origin} isn’t DorkOS. Trust sources in the app.`,
  agent: 'Nothing changed. Only a person trusts a source, in the app.',
};

/** What a failed trust says. */
const TRUST_FAILED = 'Couldn’t trust that source. Try again.';

/**
 * The front-door bar (DOR-2969): which sources DorkOS trusts is a package
 * source setting, so only the owner, at this computer, changes it.
 */
function refuseAwayFromTheComputer(c: Context<ApiEnv>): Response | undefined {
  const refusal = refuseFrontDoorChange(honoRequestFacts(c), 'which sources DorkOS trusts');
  return refusal ? problem(c, 'operator_only', { detail: refusal.error }) : undefined;
}

/**
 * Mount the trusted-source routes onto the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - The extension manager, which owns the write.
 */
export function registerTrustedSourceRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  activity?: Pick<ActivityService, 'emit'>
): void {
  // GET /api/extensions/trusted-sources -- The sources a person trusts. A read
  // of `owner/repo` names only, so it carries no bar.
  router.get('/trusted-sources', (c) => {
    const sources = configManager.get('extensions').trustedSources ?? [];
    return c.json({ sources });
  });

  // POST /api/extensions/trusted-sources -- "Yes" on "Next time, trust
  // everything from <source>?". Only a source some installed copy provably
  // comes from can be trusted: trust is granted once per PROVEN source.
  router.post('/trusted-sources', async (c) => {
    try {
      const refused = refusedNotAPerson(c, TRUST_BAR) ?? refuseAwayFromTheComputer(c);
      if (refused) return refused;
      const body = TrustedSourceRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      const source = body.success ? normalizeTrustedSource(body.data.source) : null;
      if (!source) {
        return problem(c, 'invalid_request', {
          detail: 'Send the source to trust, like owner/repo.',
        });
      }

      return runFrontDoorWrite(c, {
        kind: 'extensions.trust-source',
        target: source,
        input: { source },
        reason: `Trust extensions from ${source}.`,
        subject: 'which sources DorkOS trusts',
        run: async (confirming) => {
          try {
            const result = await extensionManager.trustSource(source);
            if (result === 'unproven') {
              return problem(c, 'conflict', {
                detail: `Nothing from ${source} is installed yet, so there’s nothing to trust.`,
                extensions: { reason: 'unproven_source' },
              });
            }
            if (result === 'added') {
              await activity?.emit({
                ...readActivityActor(confirming),
                category: 'config',
                eventType: 'config.extension_updated',
                resourceType: 'extension',
                resourceId: source,
                resourceLabel: source,
                summary: `Trusted every extension from ${source}`,
              });
            }
            return c.json({ sources: configManager.get('extensions').trustedSources ?? [] });
          } catch (err) {
            logger.error('[Extensions] Failed to trust a source', err);
            return problem(c, 'internal_error', { detail: TRUST_FAILED });
          }
        },
      });
    } catch (err) {
      logger.error('[Extensions] Failed to trust a source', err);
      return problem(c, 'internal_error', { detail: TRUST_FAILED });
    }
  });

  // DELETE /api/extensions/trusted-sources -- "Stop trusting". Extensions
  // already turned on stay on; new copies from the source ask again.
  router.delete('/trusted-sources', async (c) => {
    try {
      const refused = refusedNotAPerson(c, TRUST_BAR) ?? refuseAwayFromTheComputer(c);
      if (refused) return refused;
      const body = TrustedSourceRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      const source = body.success ? normalizeTrustedSource(body.data.source) : null;
      if (!source) {
        return problem(c, 'invalid_request', {
          detail: 'Send the source to stop trusting, like owner/repo.',
        });
      }

      const removed = await extensionManager.untrustSource(source);
      if (!removed) {
        return problem(c, 'not_found', { detail: `${source} isn’t a trusted source.` });
      }
      await activity?.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: source,
        resourceLabel: source,
        summary: `Stopped trusting every extension from ${source}`,
      });
      return c.json({ sources: configManager.get('extensions').trustedSources ?? [] });
    } catch (err) {
      logger.error('[Extensions] Failed to stop trusting a source', err);
      return problem(c, 'internal_error', {
        detail: 'Couldn’t stop trusting that source. Try again.',
      });
    }
  });
}
