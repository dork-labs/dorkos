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
import { configManager } from '../services/core/config-manager.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { logger } from '../lib/logger.js';
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
  if (enabled && !userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
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
    if (messageId)
      return c.json(
        {
          error: 'Delivery receipt response is unavailable.',
          code: 'RELAY_RECEIPT_RESPONSE_UNAVAILABLE',
          messageId,
          statusUrl,
        },
        503
      );
    if (error instanceof RelayReceiptUnavailableError)
      return c.json({ error: error.message, code: error.code }, 503);
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Publish failed',
        code: (error as { code?: string })?.code ?? 'PUBLISH_FAILED',
      },
      422
    );
  }
}

/** Authenticated, minimized SQL status; all missing/expired/inaccessible locators look alike. */
export function createReceiptStatusHandler(relayCore: RelayCore): Handler<ApiEnv> {
  return (c) => {
    c.header('Cache-Control', 'no-store');
    const enabled = loginEnabled(c);
    const userId = verifiedUserId(c);
    if (enabled && !userId) {
      return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
    }
    const id = RelayMessageIdSchema.safeParse(c.req.param('messageId'));
    if (!id.success) {
      return c.json({ error: 'Invalid relay message ID.', code: 'INVALID_RELAY_MESSAGE_ID' }, 400);
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
        return c.json(
          { error: 'Delivery receipt not found.', code: 'RELAY_RECEIPT_NOT_FOUND' },
          404
        );
      }
      return c.json(RelayDeliveryReceiptSchema.parse(receipt));
    } catch (error) {
      if (cannotRespond(c)) return UNANSWERABLE();
      return c.json(
        {
          error: 'Delivery receipt status is unavailable.',
          code:
            error instanceof RelayReceiptUnavailableError
              ? error.code
              : 'RELAY_RECEIPT_STORAGE_UNAVAILABLE',
        },
        503
      );
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
