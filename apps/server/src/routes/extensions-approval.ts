/**
 * The route a PERSON uses to allow one extension to run its code inside the
 * DorkOS server process (DOR-516), plus the list the Activity inbox asks with
 * (DOR-2517), and the one that takes that yes back. Approving stays a hand
 * route because a remote yes waits on "Confirm it's you"
 * (`holdExtensionPowerChange`); revoking stays one for now (its path's verb is
 * an API-lint ratchet). "Not now" is a person-only capability the mount serves
 * behind the same person bar (`extensions.dismiss_approval`,
 * `services/extensions/http-capabilities/`, DOR-4978).
 *
 * The record they write is `extensions.approvedToRun` in `~/.dork/config.json`,
 * classified `operator-only`. Why that home and not a project file or an
 * approval, and what the gate buys in each posture: see
 * `services/extensions/extension-load-policy.ts`.
 *
 * There is deliberately no MCP tool twin for these. Every other extension
 * operation has one; approving does not, because the agent surface is exactly the
 * surface that must not be able to approve its own code. "Not now" has none
 * either: it answers the same consent question, and an agent that could answer
 * it could hide the question from the person.
 *
 * @module routes/extensions-approval
 */
import type { ExtensionRecord } from '@dorkos/extension-api';
import { hashApprovalInput } from '../services/core/approvals/approval-input-hash.js';
import { requestCodeForHash } from '../services/core/auth/step-up/request-code.js';
import { holdExtensionPowerChange } from './extension-decision-step-up.js';
import type { RequestFacts } from '../http/request-facts.js';
import type { Context, Hono } from 'hono';
import { ApproveExtensionRequestSchema } from '@dorkos/shared/extension-approval-schemas';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { isExpectedCopy } from '../services/extensions/pin/extension-expected-copy.js';
import {
  ApprovalRefusedError,
  whyUnpinnable,
  UNPINNABLE_SENTENCE,
  UNREADABLE_SENTENCE,
} from '../services/extensions/pin/extension-content-pin.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { listPendingExtensionApprovals } from '../services/extensions/extension-approval-queue.js';
import { refusedNotAPerson } from './extensions-person-bar.js';
import { APPROVAL_BAR } from '../services/extensions/http-capabilities/extension-door-words.js';
import type { ExtensionPersonDeps } from '../services/extensions/http-capabilities/extension-person-capabilities.js';
import { registerExtensionRemovalRoutes } from './extensions-removal.js';
import { registerExtensionApprovalSetRoutes } from './extensions-approval-set.js';

/**
 * The person's extension doors on the capability mount (DOR-4978), over the
 * same manager, feed and broadcast these routes use. Empty when this server
 * runs no extensions, so the doors answer that no such action is here.
 *
 * @param manager - The extension manager, when extensions started.
 * @param activity - The Activity feed each change is recorded in.
 */
export function extensionPersonDoorDeps(
  manager: ExtensionManager | undefined,
  activity: Pick<ActivityService, 'emit'>
): { extensionPersonDeps?: ExtensionPersonDeps } {
  return manager
    ? { extensionPersonDeps: { manager, activity, broadcastReloaded: broadcastExtensionReloaded } }
    : {};
}

/** The answer for an id outside the router's pattern. */
const invalidId = (c: Context<ApiEnv>) =>
  problem(c, 'invalid_request', { detail: 'Use an extension id in lowercase, like my-extension.' });

/** The answer for an extension this computer does not have. */
const noSuchExtension = (c: Context<ApiEnv>, id: string) =>
  problem(c, 'not_found', { detail: `No extension named ${id} is installed.` });

/**
 * A `412 precondition_failed`: the copy changed since the card was drawn, so
 * the app redraws the card and asks again.
 */
const staleCopy = (c: Context<ApiEnv>, detail: string) =>
  problem(c, 'precondition_failed', { detail });

/** A `409 conflict` for a copy DorkOS cannot check: asking again can't help. */
const unpinnableCopy = (c: Context<ApiEnv>, detail: string) => problem(c, 'conflict', { detail });

/** What a request without the copy it was shown is told. */
const SEND_SHOWN = 'Send the path and version of the extension you were shown.';

/** What a stale card is told: nothing ran. */
const CHANGED = 'This extension changed since you saw it. Nothing was turned on.';

/**
 * Mount the approve and revoke routes, and the list of extensions waiting for
 * a yes, onto the extensions router.
 *
 * @param router - The extensions router to mount onto.
 * @param extensionManager - ExtensionManager instance for lifecycle operations.
 * @param safeExtId - The id pattern the parent router validates against, passed in
 *   so both files cannot drift to different notions of a valid extension id.
 * @param activity - The Activity feed the decision is recorded in, when the
 *   server has one.
 */
export function registerExtensionApprovalRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  safeExtId: RegExp,
  activity?: Pick<ActivityService, 'emit'>
): void {
  // GET /api/extensions/pending-approvals -- Every installed extension waiting
  // for a person to let it run, oldest first (DOR-2517). A read, so it carries
  // no person bar: the list names ids and display text the extensions list
  // already exposes, and the Activity inbox draws one row per item. A caller
  // the notification pipeline would not show the person's inbox to (an agent)
  // gets it without absolute paths or the home folder, the same rule the
  // inbox itself answers by.
  router.get('/pending-approvals', async (c) => {
    try {
      const forPerson =
        notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) !== 'none';
      return c.json({
        approvals: (await listPendingExtensionApprovals(extensionManager, { forPerson })).map(
          (approval) => ({
            ...approval,
            ...(forPerson
              ? {
                  requestCode: requestCodeForHash(
                    hashApprovalInput({
                      effect: 'extension-approve',
                      snapshot: extensionApprovalSnapshot(extensionManager.get(approval.id)),
                    })
                  ),
                }
              : {}),
          })
        ),
      });
    } catch (err) {
      logger.error('[Extensions] Failed to list extensions waiting for approval', err);
      return problem(c, 'internal_error', {
        detail: 'Couldn’t list extensions waiting. Try again.',
      });
    }
  });

  // POST /api/extensions/:id/approve -- Record that a person approved this
  // extension to run code inside the DorkOS server process, and start it.
  router.post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return invalidId(c);
      const refused = refusedNotAPerson(c, APPROVAL_BAR);
      if (refused) return refused;

      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);
      // Core extensions ship inside DorkOS and are exempt by origin, so there is no
      // approval to record for one. Say so rather than writing a list entry that
      // changes nothing.
      if (record.origin === 'core') {
        return problem(c, 'conflict', {
          detail: `${id} ships with DorkOS, so it needs no approval.`,
        });
      }

      // The copy the person was shown, when the click came from a row that
      // named one (the Activity inbox, DOR-2517). The approval binds whatever
      // copy is on disk NOW, so a row that went out of date — another plugin
      // took the id, a project folder reused it, the version moved — must
      // not approve the newcomer on the strength of a decision about the old.
      const body = readJsonBody(c);
      const hasBody = body !== undefined && Object.keys(body as object).length > 0;
      let expectedDigest: string | undefined;
      if (hasBody) {
        const expected = ApproveExtensionRequestSchema.safeParse(body);
        if (!expected.success) {
          return problem(c, 'invalid_request', { detail: SEND_SHOWN });
        }
        if (!isExpectedCopy(record, expected.data)) {
          return staleCopy(c, CHANGED);
        }
        // The files the card showed (DOR-3068): the manager refuses the yes
        // when they changed since, with the live digest read at the click.
        expectedDigest = expected.data.expectedDigest;
      }

      // A yes names the files the person was shown (DOR-3068), so every copy
      // but a dev link (approved by path, DOR-2696) must say which they were.
      // A card that named none was drawn for a copy DorkOS could not check, or
      // is out of date; either way the person reads why in plain words.
      if (!record.devLink && expectedDigest === undefined) {
        return record.currentDigest
          ? staleCopy(c, CHANGED)
          : unpinnableCopy(c, await whyUnpinnable(record));
      }

      const run = async (facts: RequestFacts): Promise<Response> => {
        const current = extensionManager.get(id);
        if (
          !current ||
          current.path !== record.path ||
          current.manifest.version !== record.manifest.version
        )
          return staleCopy(c, 'This mini app changed. Nothing was turned on.');
        let extension;
        try {
          extension = await extensionManager.approveToRun(id, { expectedDigest });
        } catch (err) {
          if (!(err instanceof ApprovalRefusedError)) throw err;
          // A fixed sentence per case, never the error's own text (it can name
          // files): one of the two unpinnable sentences, else the unreadable one.
          logger.warn(`[Extensions] Approval of ${id} refused`, err);
          if (err.reason === 'stale') return staleCopy(c, CHANGED);
          const why =
            err.message === UNPINNABLE_SENTENCE ? UNPINNABLE_SENTENCE : UNREADABLE_SENTENCE;
          return unpinnableCopy(c, why);
        }
        if (!extension) return noSuchExtension(c, id);

        await activity?.emit({
          // Always the person — the bar above refuses any caller naming itself an
          // agent — and read from the caller anyway, so every Activity entry on
          // this router derives who acted rather than asserting it (DOR-1801).
          ...readActivityActor(facts),
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: extension.manifest.name,
          summary: `Allowed ${extension.manifest.name} to run code inside DorkOS`,
        });

        // The server half is live now, so tell every connected client to pick up the
        // extension's contributions instead of waiting for a page reload.
        broadcastExtensionReloaded([id]);

        // The one-time "Next time, trust everything from <source>?" (spec
        // `flow-multiproject` §9.3, V9): only when this copy provably came from a
        // source the person does not trust yet. Returned to the app that
        // answered and never stored, so it shows once, on that device.
        const trustSource = extensionManager.trustOfferFor(id);
        return c.json({
          extension,
          ...(trustSource ? { trustOffer: { source: trustSource } } : {}),
        });
      };
      const held = holdExtensionPowerChange(c, {
        id,
        effect: 'extension-approve',
        copy: APPROVAL_BAR,
        reason: `Allow ${record.manifest.name} to run.`,
        read: () => {
          return extensionApprovalSnapshot(extensionManager.get(id));
        },
        run,
      });
      return held ?? (await run(honoRequestFacts(c)));
    } catch (err) {
      logger.error(`[Extensions] Failed to approve ${id}`, err);
      return problem(c, 'internal_error', { detail: 'Couldn’t allow the extension. Try again.' });
    }
  });

  // POST /api/extensions/:id/revoke -- Withdraw that approval and stop the
  // extension's server-side code immediately.
  router.post('/:id/revoke', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return invalidId(c);
      const refused = refusedNotAPerson(c, APPROVAL_BAR);
      if (refused) return refused;

      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);
      if (record.origin === 'core') {
        return problem(c, 'conflict', { detail: `${id} ships with DorkOS. Turn it off instead.` });
      }

      const extension = await extensionManager.revokeRunApproval(id);
      if (!extension) return noSuchExtension(c, id);

      await activity?.emit({
        // Always the person — the bar above refuses any caller naming itself an
        // agent — and read from the caller anyway, so every Activity entry on
        // this router derives who acted rather than asserting it (DOR-1801).
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: extension.manifest.name,
        summary: `Stopped ${extension.manifest.name} from running code inside DorkOS`,
      });

      broadcastExtensionReloaded([id]);

      return c.json({ extension });
    } catch (err) {
      logger.error(`[Extensions] Failed to revoke approval for ${id}`, err);
      return problem(c, 'internal_error', { detail: 'Couldn’t stop the extension. Try again.' });
    }
  });

  // The approvals left behind by removed extensions (DOR-3372). Removing one and
  // forgetting what it was allowed, and "Not now", are on the capability mount
  // behind the same bar (DOR-4978).
  registerExtensionRemovalRoutes(router, extensionManager);
  // "Allow all" for a plugin's extensions, behind this same bar (DOR-3583).
  registerExtensionApprovalSetRoutes(router, extensionManager, APPROVAL_BAR, activity);
}

/** The copy and every declared power covered by a mini-app approval. */
function extensionApprovalSnapshot(record: ExtensionRecord | undefined) {
  return record
    ? {
        id: record.id,
        path: record.path,
        manifest: record.manifest,
        digest: record.currentDigest ?? null,
        devLink: record.devLink ?? false,
        sourcePlugin: record.sourcePlugin ?? null,
      }
    : null;
}
