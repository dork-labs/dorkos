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
import {
  holdRemoteExtensionAnswer,
  holdRemoteExtensionSettings,
} from './extension-decision-step-up.js';
import { grantsPower } from '../services/core/approvals/model/approval-answer-policy.js';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';
import type { Hono } from 'hono';
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
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { DECISION_BAR, recordSettingsChange } from './extension-decisions.js';
import { answerOutcome, decisionRefusal } from './extension-decision-problems.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What a caller is told while the inbox is not up. */
const INBOX_NOT_READY = 'The inbox isn’t ready yet. Try again in a moment.';

/** What the settings route says when the bar refuses it. */
const SETTINGS_BAR: PersonBarCopy = {
  code: 'person_only',
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
    if (!safeExtId.test(id))
      return problem(c, 'invalid_request', { detail: 'Use a valid extension ID.' });
    const inbox = getExtensionInbox();
    if (!inbox) return problem(c, 'temporarily_unavailable', { detail: INBOX_NOT_READY });
    return c.json({ decisions: inbox.listOpen(id), offers: [] });
  });

  router.post('/:id/decisions/:decisionId/action', async (c) => {
    try {
      const { id, decisionId } = c.req.param();
      if (!safeExtId.test(id))
        return problem(c, 'invalid_request', { detail: 'Use a valid extension ID.' });
      const refused = refusedNotAPerson(c, DECISION_BAR);
      if (refused) return refused;
      const body = DecisionActionRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      if (!body.success) {
        return validationProblem(c, body.error, {
          detail: 'Send an action, and keep notes under 2000 characters.',
        });
      }
      const inbox = getExtensionInbox();
      if (!inbox) return problem(c, 'temporarily_unavailable', { detail: INBOX_NOT_READY });
      const run = async (): Promise<StepUpCommitResult> => {
        const outcome = await inbox.answer(decisionId, body.data, {
          kind: 'extension',
          extensionId: id,
        });
        return outcome.ok ? { status: 200, body: outcome.response } : decisionRefusal(outcome);
      };
      if (grantsPower({ kind: body.data.action === 'reject' ? 'reject' : 'extension-answer' })) {
        const held = holdRemoteExtensionAnswer(
          c,
          { id: decisionId, kind: 'decision', inbox, copy: DECISION_BAR, extensionId: id },
          run
        );
        if (held) return held;
      }
      const outcome = await run();
      return answerOutcome(c, outcome);
    } catch (err) {
      logger.error('[Extensions] Failed to answer a decision from an extension page', err);
      return problem(c, 'internal_error', { detail: 'The answer wasn’t saved. Try again.' });
    }
  });

  router.get('/:id/project-settings', async (c) => {
    try {
      const id = c.req.param('id');
      if (!safeExtId.test(id))
        return problem(c, 'invalid_request', { detail: 'Use a valid extension ID.' });
      const query = ProjectSettingsQuerySchema.safeParse(readQuery(c));
      if (!query.success)
        return validationProblem(c, query.error, { detail: 'Send ?project=<folder>.' });
      const resolved = await projectRegistry.resolveWithin(query.data.project, id);
      if (resolved === 'outside')
        return problem(c, 'outside_boundary', {
          detail: 'Pick a folder DorkOS may read.',
        });
      if (!resolved) return c.json({ value: null, updatedAt: null, updatedBy: null });
      const stored = await projectSettingsStore(dorkHome).read(id, resolved.root);
      return c.json({
        value: stored?.value ?? null,
        updatedAt: stored?.updatedAt ?? null,
        updatedBy: stored?.updatedBy ?? null,
      });
    } catch (err) {
      logger.error('[Extensions] Failed to read project settings', err);
      return problem(c, 'internal_error', { detail: 'Couldn’t read project settings. Try again.' });
    }
  });

  router.put('/:id/project-settings', async (c) => {
    try {
      const id = c.req.param('id');
      if (!safeExtId.test(id))
        return problem(c, 'invalid_request', { detail: 'Use a valid extension ID.' });
      const refused = refusedNotAPerson(c, SETTINGS_BAR);
      if (refused) return refused;
      const body = PutProjectSettingsRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      if (!body.success || body.data.value === undefined) {
        return problem(c, 'invalid_request', { detail: 'Send { project, value }.' });
      }
      const record = extensionManager.get(id);
      if (!record) return problem(c, 'not_found', { detail: `No extension named ${id}.` });
      const resolved = await projectRegistry.resolveWithin(body.data.project, id);
      const allowed =
        resolved && resolved !== 'outside' ? await projectRegistry.listForExtension(id) : [];
      if (!resolved || resolved === 'outside' || !allowed.some((p) => p.root === resolved.root)) {
        return problem(c, 'not_found', {
          detail: `${record.manifest.name} is not set up in that project.`,
        });
      }
      const run = async (facts: RequestFacts): Promise<Response> => {
        const current = extensionManager.get(id);
        const projects = await projectRegistry.listForExtension(id);
        if (!current || !projects.some((p) => p.root === resolved.root))
          return problem(c, 'not_found', { detail: 'That project is no longer available.' });
        try {
          await projectSettingsStore(dorkHome).write(
            id,
            resolved.root,
            body.data.value,
            'extension-page'
          );
        } catch (err) {
          if (err instanceof ProjectSettingsError)
            return problem(c, err.code === 'too_large' ? 'request_too_large' : 'invalid_request', {
              detail:
                err.code === 'too_large'
                  ? 'Keep project settings under 16 KB.'
                  : 'Send project settings as plain JSON.',
            });
          throw err;
        }
        await recordSettingsChange(activity, facts, {
          extensionId: id,
          extensionName: current.manifest.name,
          projectName: resolved.name,
        });
        return c.body(null, 204);
      };
      const held = await holdRemoteExtensionSettings(c, {
        id,
        copy: SETTINGS_BAR,
        project: body.data.project,
        value: body.data.value,
        read: () => ({
          t: 'dorkos.extension-settings.step-up.v1',
          extensionId: id,
          manifest: extensionManager.get(id)?.manifest ?? null,
          project: resolved.root,
          value: body.data.value,
        }),
        run,
      });
      return held ?? (await run(honoRequestFacts(c)));
    } catch (err) {
      logger.error('[Extensions] Failed to write project settings', err);
      return problem(c, 'internal_error', { detail: 'Couldn’t save project settings. Try again.' });
    }
  });
}
