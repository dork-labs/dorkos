/** HTTP receipt ownership and response boundaries, independent of message payloads. */
import type { Context, Handler } from 'hono';
import {
  isDetachedAgentSubject,
  RelayReceiptUnavailableError,
  extractSessionIdFromSubject,
  type RelayCore,
  type PublishResult,
} from '@dorkos/relay';
import {
  RelayDeliveryReceiptSchema,
  RelayMessageIdSchema,
  type RelaySendMessageRequest,
} from '@dorkos/shared/relay-schemas';
import { honoRequestFacts } from '../http/request-facts.js';
import { credentialGated } from '../services/core/auth/gate-policy.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { logger } from '../lib/logger.js';
import { problem } from '@dorkos/http-kit';
import { authRequiredBody } from '../services/core/auth/session-gate.js';
import type { ApiEnv } from '../http/api-chain.js';

/** What publishing reads besides the message: the bus, and what an adapter delivery is recorded in. */
export interface RelayPublishDeps {
  /** The message bus. */
  relayCore: RelayCore;
  /** Names the adapter a delivery went through, when one did. */
  adapterManager?: AdapterManager;
  /** Where adapter deliveries and failures are recorded. */
  activity?: ActivityService;
}

/** Delivery statuses can't be read or written right now. */
const RECEIPTS_UNAVAILABLE = 'Delivery status isn’t available right now. Try again soon.';

/** The answer for a client that is gone: nothing more is written to it. */
const UNANSWERABLE = (): Response => new Response(null);

/** Whether the gate asked this request for a credential (per request, not one switch). */
function loginEnabled(c: Context<ApiEnv>): boolean {
  return credentialGated(honoRequestFacts(c));
}
function verifiedUserId(c: Context<ApiEnv>): string | null {
  const id: unknown = c.get('user')?.userId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
function cannotRespond(c: Context<ApiEnv>): boolean {
  const { outgoing } = c.env;
  return outgoing.headersSent || outgoing.writableEnded || outgoing.destroyed;
}

/** Publish with a locator captured by the durable acceptance callback, never error metadata. */
export async function publishRelayMessage(
  c: Context<ApiEnv>,
  deps: RelayPublishDeps,
  data: RelaySendMessageRequest
): Promise<Response> {
  const { relayCore } = deps;
  let messageId: string | undefined;
  let statusUrl: string | undefined;
  const tracked = isDetachedAgentSubject(data.subject);
  const enabled = loginEnabled(c);
  const userId = verifiedUserId(c);
  if (enabled && !userId) return c.json(authRequiredBody(), 401);
  try {
    const publishResult = await relayCore.publish(data.subject, data.payload, {
      from: data.from,
      replyTo: data.replyTo,
      budget: data.budget,
      ...(tracked
        ? {
            receiptContext: {
              ownerUserId: enabled ? userId : null,
              onReceiptCreated: (id: string) => {
                messageId = id;
                statusUrl = `/api/relay/messages/${id}/status`;
              },
            },
          }
        : {}),
    });
    await emitPublishActivity(deps, publishResult, data);
    if (cannotRespond(c)) return UNANSWERABLE();
    return c.json({ ...publishResult, ...(statusUrl ? { statusUrl } : {}) });
  } catch (error) {
    if (cannotRespond(c)) return UNANSWERABLE();
    // The message may have gone out: the answer says where to check it.
    if (messageId)
      return problem(c, 'temporarily_unavailable', {
        detail: 'The message may have gone. Check its status link.',
        extensions: { messageId, statusUrl },
      });
    if (error instanceof RelayReceiptUnavailableError)
      return problem(c, 'temporarily_unavailable', { detail: RECEIPTS_UNAVAILABLE });
    // The bus refuses with its own words, which can name senders and rules: logged only.
    logger.info('[relay] POST /messages refused', { error });
    return problem(c, 'invalid_request', {
      detail: 'DorkOS couldn’t send that message. Check its address and sender.',
    });
  }
}

/** Authenticated, minimized SQL status; all missing/expired/inaccessible locators look alike. */
export function createReceiptStatusHandler(relayCore: RelayCore): Handler<ApiEnv> {
  return (c) => {
    c.header('Cache-Control', 'no-store');
    const enabled = loginEnabled(c);
    const userId = verifiedUserId(c);
    if (enabled && !userId) {
      return c.json(authRequiredBody(), 401);
    }
    const id = RelayMessageIdSchema.safeParse(c.req.param('messageId'));
    if (!id.success) {
      return problem(c, 'invalid_request', { detail: 'That isn’t a message id.' });
    }
    try {
      const receipt = relayCore.getDeliveryReceipt(
        id.data,
        enabled
          ? {
              loginEnabled: true,
              userId: userId!,
              installOwnerUserId: readOwnerAccount()?.id ?? null,
            }
          : { loginEnabled: false }
      );
      if (!receipt) {
        return problem(c, 'not_found', { detail: 'No delivery status for that message.' });
      }
      return c.json(RelayDeliveryReceiptSchema.parse(receipt));
    } catch (error) {
      if (cannotRespond(c)) return UNANSWERABLE();
      if (!(error instanceof RelayReceiptUnavailableError)) {
        logger.error('[relay] reading a delivery status failed', { error });
      }
      return problem(c, 'temporarily_unavailable', { detail: RECEIPTS_UNAVAILABLE });
    }
  };
}

/** Auxiliary activity cannot change publication outcome or disclose a thrown error. */
async function emitPublishActivity(
  deps: RelayPublishDeps,
  publishResult: PublishResult,
  data: RelaySendMessageRequest
) {
  const { adapterManager, activity: activityService } = deps;
  try {
    // Emit message delivery/failure activity events when an adapter was involved
    if (publishResult.adapterResult && adapterManager) {
      if (activityService) {
        const from = data.from;
        const isAgent = from?.startsWith('relay.agent.');
        const actorType = isAgent ? ('agent' as const) : ('system' as const);
        // Extract the sessionId/agentId slot via the shared parser so both
        // legacy and runtime-scoped `from` subjects produce a stable label.
        const actorLabel = isAgent ? (extractSessionIdFromSubject(from) ?? 'Agent') : 'System';

        // Resolve adapter from the subject
        const matchedAdapter = adapterManager.getRegistry().getBySubject(data.subject);
        const adapterId = matchedAdapter?.id ?? 'unknown';
        const adapterName = adapterManager.resolveAdapterName(adapterId);

        if (publishResult.adapterResult.success) {
          // Agent deliveries are detached: success here means the message
          // was accepted for a turn, not that the turn completed.
          const isAgentSubject = data.subject.startsWith('relay.agent.');
          await activityService.emit({
            actorType,
            actorLabel,
            category: 'relay',
            eventType: 'relay.message_delivered',
            resourceType: 'adapter',
            resourceId: adapterId,
            resourceLabel: adapterName,
            summary: isAgentSubject
              ? `Accepted message for ${adapterName}`
              : `Delivered message via ${adapterName}`,
            linkPath: '/',
          });
        } else {
          await activityService.emit({
            actorType,
            actorLabel,
            category: 'relay',
            eventType: 'relay.message_failed',
            resourceType: 'adapter',
            resourceId: adapterId,
            resourceLabel: adapterName,
            summary: `Failed to deliver via ${adapterName}: ${publishResult.adapterResult.error ?? 'unknown error'}`,
            linkPath: '/',
            metadata: { error: publishResult.adapterResult.error ?? 'unknown error' },
          });
        }
      }
    }
  } catch {
    logger.warn('[relay] Message activity could not be recorded.');
  }
}
