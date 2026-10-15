/**
 * The routes an extension's own pages reach through `api.listDecisions`,
 * `api.answerDecision` and `api.projectSettings` (spec `flow-multiproject`
 * §7.3, §7.10, §11.3).
 *
 * | Route                                                 | Bar                  |
 * | ----------------------------------------------------- | -------------------- |
 * | `GET /api/extensions/:id/decisions`                   | normal API auth      |
 * | `POST /api/extensions/:id/decisions/:decisionId/action` | `refuseIfNotAPerson` |
 * | `GET /api/extensions/:id/project-settings?project=`   | normal API auth      |
 * | `PUT /api/extensions/:id/project-settings`            | `refuseIfNotAPerson` |
 *
 * **Scoped to `:id`.** The client host fills `:id` with the calling
 * extension's own id, and the server answers only that extension's rows: a
 * decision raised by another extension is `404`. That stops mistakes and
 * keeps each extension's surface to its own rows; it is not a wall against a
 * hostile approved extension, which shares the page (invariant 9).
 *
 * **Attributed to the extension.** An answer here is recorded as
 * `resolved_by = 'extension'`, "answered in Flow", never as the person, and it
 * never carries a follow-up offer: only core's own UI can say a person
 * answered. A settings write here is recorded `updatedBy: 'extension-page'`
 * for the same reason.
 *
 * @module routes/extensions-inbox
 */
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  DecisionActionRequestSchema,
  ProjectSettingsQuerySchema,
  PutProjectSettingsRequestSchema,
} from '@dorkos/shared/extension-decision-schemas';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { getExtensionInbox } from '../services/extensions/inbox/extension-inbox.js';
import {
  projectSettingsStore,
  ProjectSettingsError,
} from '../services/extensions/inbox/extension-project-settings.js';
import { projectRegistry } from '../services/projects/project-registry.js';
import { logger } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { DECISION_BAR, recordSettingsChange } from './extension-decisions.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What the settings route says when the bar refuses it. */
const SETTINGS_BAR: PersonBarCopy = {
  error: 'Only a person can change these settings.',
  code: 'extension_person_required',
  subject: "an extension's project settings",
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can change these settings.`,
  agent:
    'DorkOS changed nothing. Only a person can change these settings. Ask them to change it in DorkOS.',
};

/**
 * Mount the extension-scoped inbox and project-settings routes.
 *
 * @param router - The extensions router.
 * @param extensionManager - For the extension's name and existence.
 * @param dorkHome - The DorkOS data directory.
 * @param safeExtId - The id pattern the parent router validates against.
 * @param activity - The Activity feed a settings change is recorded in.
 */
export function registerExtensionInboxRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  dorkHome: string,
  safeExtId: RegExp,
  activity?: Pick<ActivityService, 'emit'>
): void {
  router.get('/:id/decisions', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    const inbox = getExtensionInbox();
    if (!inbox) return c.json({ error: 'The inbox is not available yet.' }, 503);
    return c.json({ decisions: inbox.listOpen(id), offers: [] });
  });

  router.post('/:id/decisions/:decisionId/action', async (c) => {
    try {
      const { id, decisionId } = c.req.param();
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, DECISION_BAR);
      if (refused) return refused;
      const body = DecisionActionRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      if (!body.success) {
        return c.json({ error: 'Send an action, and keep notes under 2000 characters.' }, 400);
      }
      const inbox = getExtensionInbox();
      if (!inbox) return c.json({ error: 'The inbox is not available yet.' }, 503);
      const outcome = await inbox.answer(decisionId, body.data, {
        kind: 'extension',
        extensionId: id,
      });
      if (!outcome.ok) {
        return c.json(
          { error: outcome.message, code: outcome.code },
          outcome.status as ContentfulStatusCode
        );
      }
      return c.json(outcome.response);
    } catch (err) {
      logger.error('[Extensions] Failed to answer a decision from an extension page', err);
      return c.json({ error: 'Failed to answer the decision' }, 500);
    }
  });

  router.get('/:id/project-settings', async (c) => {
    try {
      const id = c.req.param('id');
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const query = ProjectSettingsQuerySchema.safeParse(readQuery(c));
      if (!query.success) return c.json({ error: 'Send ?project=<folder>' }, 400);
      const resolved = await projectRegistry.resolveWithin(query.data.project, id);
      if (resolved === 'outside')
        return c.json({ error: 'That folder is outside what DorkOS may read.' }, 403);
      if (!resolved) return c.json({ value: null, updatedAt: null, updatedBy: null });
      const stored = await projectSettingsStore(dorkHome).read(id, resolved.root);
      return c.json({
        value: stored?.value ?? null,
        updatedAt: stored?.updatedAt ?? null,
        updatedBy: stored?.updatedBy ?? null,
      });
    } catch (err) {
      logger.error('[Extensions] Failed to read project settings', err);
      return c.json({ error: 'Failed to read project settings' }, 500);
    }
  });

  router.put('/:id/project-settings', async (c) => {
    try {
      const id = c.req.param('id');
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, SETTINGS_BAR);
      if (refused) return refused;
      const body = PutProjectSettingsRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      if (!body.success || body.data.value === undefined) {
        return c.json({ error: 'Send { project, value }.' }, 400);
      }
      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);
      const resolved = await projectRegistry.resolveWithin(body.data.project, id);
      const allowed =
        resolved && resolved !== 'outside' ? await projectRegistry.listForExtension(id) : [];
      if (!resolved || resolved === 'outside' || !allowed.some((p) => p.root === resolved.root)) {
        return c.json({ error: `${record.manifest.name} is not set up in that project.` }, 404);
      }
      try {
        await projectSettingsStore(dorkHome).write(
          id,
          resolved.root,
          body.data.value,
          'extension-page'
        );
      } catch (err) {
        if (err instanceof ProjectSettingsError) {
          return c.json(
            { error: err.message, code: err.code },
            err.code === 'too_large' ? 413 : 400
          );
        }
        throw err;
      }
      await recordSettingsChange(activity, honoRequestFacts(c), {
        extensionId: id,
        extensionName: record.manifest.name,
        projectName: resolved.name,
      });
      return c.body(null, 204);
    } catch (err) {
      logger.error('[Extensions] Failed to write project settings', err);
      return c.json({ error: 'Failed to write project settings' }, 500);
    }
  });
}
