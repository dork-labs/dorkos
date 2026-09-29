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
import type { Router } from 'express';
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
import { DECISION_BAR, recordSettingsChange } from './extension-decisions.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

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
 */
export function registerExtensionInboxRoutes(
  router: Router,
  extensionManager: ExtensionManager,
  dorkHome: string,
  safeExtId: RegExp
): void {
  router.get('/:id/decisions', (req, res) => {
    const { id } = req.params;
    if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    const inbox = getExtensionInbox();
    if (!inbox) return res.status(503).json({ error: 'The inbox is not available yet.' });
    return res.json({ decisions: inbox.listOpen(id), offers: [] });
  });

  router.post('/:id/decisions/:decisionId/action', async (req, res) => {
    try {
      const { id, decisionId } = req.params;
      if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      if (refuseIfNotAPerson(req, res, DECISION_BAR)) return undefined;
      const body = DecisionActionRequestSchema.safeParse(req.body ?? {});
      if (!body.success) {
        return res
          .status(400)
          .json({ error: 'Send an action, and keep notes under 2000 characters.' });
      }
      const inbox = getExtensionInbox();
      if (!inbox) return res.status(503).json({ error: 'The inbox is not available yet.' });
      const outcome = await inbox.answer(decisionId, body.data, {
        kind: 'extension',
        extensionId: id,
      });
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.message, code: outcome.code });
      }
      return res.json(outcome.response);
    } catch (err) {
      logger.error('[Extensions] Failed to answer a decision from an extension page', err);
      return res.status(500).json({ error: 'Failed to answer the decision' });
    }
  });

  router.get('/:id/project-settings', async (req, res) => {
    try {
      const { id } = req.params;
      if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const query = ProjectSettingsQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: 'Send ?project=<folder>' });
      const resolved = await projectRegistry.resolveWithin(query.data.project, id);
      if (resolved === 'outside')
        return res.status(403).json({ error: 'That folder is outside what DorkOS may read.' });
      if (!resolved) return res.json({ value: null, updatedAt: null, updatedBy: null });
      const stored = await projectSettingsStore(dorkHome).read(id, resolved.root);
      return res.json({
        value: stored?.value ?? null,
        updatedAt: stored?.updatedAt ?? null,
        updatedBy: stored?.updatedBy ?? null,
      });
    } catch (err) {
      logger.error('[Extensions] Failed to read project settings', err);
      return res.status(500).json({ error: 'Failed to read project settings' });
    }
  });

  router.put('/:id/project-settings', async (req, res) => {
    try {
      const { id } = req.params;
      if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      if (refuseIfNotAPerson(req, res, SETTINGS_BAR)) return undefined;
      const body = PutProjectSettingsRequestSchema.safeParse(req.body ?? {});
      if (!body.success || body.data.value === undefined) {
        return res.status(400).json({ error: 'Send { project, value }.' });
      }
      const record = extensionManager.get(id);
      if (!record) return res.status(404).json({ error: `Extension '${id}' not found` });
      const resolved = await projectRegistry.resolveWithin(body.data.project, id);
      const allowed =
        resolved && resolved !== 'outside' ? await projectRegistry.listForExtension(id) : [];
      if (!resolved || resolved === 'outside' || !allowed.some((p) => p.root === resolved.root)) {
        return res
          .status(404)
          .json({ error: `${record.manifest.name} is not set up in that project.` });
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
          return res
            .status(err.code === 'too_large' ? 413 : 400)
            .json({ error: err.message, code: err.code });
        }
        throw err;
      }
      await recordSettingsChange(req, res, {
        extensionId: id,
        extensionName: record.manifest.name,
        projectName: resolved.name,
      });
      return res.status(204).end();
    } catch (err) {
      logger.error('[Extensions] Failed to write project settings', err);
      return res.status(500).json({ error: 'Failed to write project settings' });
    }
  });
}
