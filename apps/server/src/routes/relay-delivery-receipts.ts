/** HTTP receipt ownership and response boundaries, independent of message payloads. */
import type { Request, Response, RequestHandler } from 'express';
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
import { configManager } from '../services/core/config-manager.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { logger } from '../lib/logger.js';

function loginEnabled(): boolean {
  return !!configManager.get('auth')?.enabled;
}
function verifiedUserId(res: Response): string | null {
  const id: unknown = res.locals.user?.userId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
function cannotRespond(res: Response): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

/** Publish with a locator captured by the durable acceptance callback, never error metadata. */
export async function publishRelayMessage(
  req: Request,
  res: Response,
  relayCore: RelayCore,
  adapterManager: AdapterManager | undefined,
  data: RelaySendMessageRequest
) {
  let messageId: string | undefined;
  let statusUrl: string | undefined;
  const tracked = isDetachedAgentSubject(data.subject);
  const enabled = loginEnabled();
  const userId = verifiedUserId(res);
  if (enabled && !userId)
    return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
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
    await emitPublishActivity(req, publishResult, adapterManager, data);
    if (cannotRespond(res)) return;
    return res.json({ ...publishResult, ...(statusUrl ? { statusUrl } : {}) });
  } catch (error) {
    if (cannotRespond(res)) return;
    if (messageId)
      return res.status(503).json({
        error: 'Delivery receipt response is unavailable.',
        code: 'RELAY_RECEIPT_RESPONSE_UNAVAILABLE',
        messageId,
        statusUrl,
      });
    if (error instanceof RelayReceiptUnavailableError)
      return res.status(503).json({ error: error.message, code: error.code });
    return res.status(422).json({
      error: error instanceof Error ? error.message : 'Publish failed',
      code: (error as { code?: string })?.code ?? 'PUBLISH_FAILED',
    });
  }
}

/** Authenticated, minimized SQL status; all missing/expired/inaccessible locators look alike. */
export function createReceiptStatusHandler(relayCore: RelayCore): RequestHandler {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    const enabled = loginEnabled();
    const userId = verifiedUserId(res);
    if (enabled && !userId) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      return;
    }
    const id = RelayMessageIdSchema.safeParse(req.params.messageId);
    if (!id.success) {
      res
        .status(400)
        .json({ error: 'Invalid relay message ID.', code: 'INVALID_RELAY_MESSAGE_ID' });
      return;
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
        res
          .status(404)
          .json({ error: 'Delivery receipt not found.', code: 'RELAY_RECEIPT_NOT_FOUND' });
        return;
      }
      res.json(RelayDeliveryReceiptSchema.parse(receipt));
    } catch (error) {
      if (cannotRespond(res)) return;
      res.status(503).json({
        error: 'Delivery receipt status is unavailable.',
        code:
          error instanceof RelayReceiptUnavailableError
            ? error.code
            : 'RELAY_RECEIPT_STORAGE_UNAVAILABLE',
      });
    }
  };
}

/** Auxiliary activity cannot change publication outcome or disclose a thrown error. */
async function emitPublishActivity(
  req: Request,
  publishResult: PublishResult,
  adapterManager: AdapterManager | undefined,
  data: RelaySendMessageRequest
) {
  try {
    // Emit message delivery/failure activity events when an adapter was involved
    if (publishResult.adapterResult && adapterManager) {
      const activityService = req.app.locals.activityService as ActivityService | undefined;
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
