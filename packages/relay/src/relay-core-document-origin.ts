import { dispatchTurnAccounting, type RelayTurnCeiling } from './turn-ceiling.js';
import type { AccessControl } from './access-control.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type {
  ServerDocumentRelayOrigin,
  ServerDocumentRelayAccess,
  OriginalDocumentRelayWake,
} from './document-delivery.js';
import { requireOriginalRelayCoreOwner, type RelayCore } from './relay-core.js';
import type { PublishResult } from './relay-publish.js';
export interface OriginalDocumentOriginContext {
  relay: RelayCore;
  accessControl: AccessControl;
  originalRegistry: SubscriptionRegistry;
  requireOpen: () => void;
  originalAccessCheck: AccessControl['checkAccess'];
  originalDocumentSubscribe: SubscriptionRegistry['subscribe'];
  issueOrigin: (origin: ServerDocumentRelayOrigin, access: ServerDocumentRelayAccess) => void;
  publishDocumentWake: (wake: OriginalDocumentRelayWake) => Promise<PublishResult>;
  documentTurnCeiling: RelayTurnCeiling;
}
/** Only original constructor custody can assemble the server's private document origin. */
export function createOriginalServerDocumentOrigin(ownerKey: object) {
  const context = requireOriginalRelayCoreOwner(ownerKey);
  const relay = context.relay;
  const origin = Object.freeze(Object.create(null)) as ServerDocumentRelayOrigin;
  const accessControl = context.accessControl;
  const originalRegistry = context.originalRegistry;
  const requireOpen = context.requireOpen;
  context.issueOrigin(
    origin,
    Object.freeze({
      requireOpen,
      publishAcceptedDocumentWake: (
        wake: import('./document-delivery.js').OriginalDocumentRelayWake
      ) => {
        requireOpen();
        // Capture primitive own fields before ACL/configuration work can reenter.
        const keys = [
          'documentId',
          'batchId',
          'generation',
          'openerAgentId',
          'targetAgentId',
        ] as const;
        if (
          !wake ||
          Object.getPrototypeOf(wake) !== Object.prototype ||
          Object.keys(wake).length !== keys.length
        )
          throw new Error('DOCUMENT_RELAY_WAKE_DATA_REQUIRED');
        const data: Record<string, string> = {};
        for (const key of keys) {
          const field = Object.getOwnPropertyDescriptor(wake, key);
          if (
            !field ||
            !('value' in field) ||
            typeof field.value !== 'string' ||
            !field.value ||
            Buffer.byteLength(field.value) > 4096
          )
            throw new Error('DOCUMENT_RELAY_WAKE_FIELD_INVALID');
          data[key] = field.value;
        }
        const identifier = /^[A-Za-z0-9_-]{1,200}$/u;
        if (!identifier.test(data.openerAgentId!) || !identifier.test(data.targetAgentId!))
          throw new Error('DOCUMENT_RELAY_AGENT_ID_INVALID');
        const result = context.originalAccessCheck.call(
          accessControl,
          `relay.agent.${data.openerAgentId}`,
          `relay.agent.${data.targetAgentId}`
        );
        if (!result.allowed || result.matchedRule?.action !== 'allow')
          throw new Error('DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED');
        requireOpen();
        return context.publishDocumentWake(
          Object.freeze(
            data
          ) as unknown as import('./document-delivery.js').OriginalDocumentRelayWake
        );
      },
      subscribeDocumentWakes: (
        listener: (wake: import('./document-delivery.js').OriginalDocumentRelayWake) => void
      ) => {
        requireOpen();
        if (typeof listener !== 'function')
          throw new Error('DOCUMENT_RELAY_DATA_LISTENER_REQUIRED');
        return context.originalDocumentSubscribe.call(
          originalRegistry,
          'relay.doc.batch',
          (envelope) => {
            requireOpen();
            if (envelope.subject !== 'relay.doc.batch' || envelope.from !== 'relay.doc.publisher')
              return;
            const wake = envelope.payload,
              keys = [
                'documentId',
                'batchId',
                'generation',
                'openerAgentId',
                'targetAgentId',
              ] as const;
            if (
              !wake ||
              typeof wake !== 'object' ||
              Object.getPrototypeOf(wake) !== Object.prototype ||
              Object.keys(wake).length !== keys.length
            )
              throw new Error('DOCUMENT_RELAY_WAKE_DATA_REQUIRED');
            const data: Record<string, string> = {};
            for (const key of keys) {
              const slot = Object.getOwnPropertyDescriptor(wake, key);
              if (
                !slot ||
                !('value' in slot) ||
                typeof slot.value !== 'string' ||
                !slot.value ||
                Buffer.byteLength(slot.value) > 4096
              )
                throw new Error('DOCUMENT_RELAY_WAKE_FIELD_INVALID');
              data[key] = slot.value;
            }
            requireOpen();
            listener(
              Object.freeze(
                data
              ) as unknown as import('./document-delivery.js').OriginalDocumentRelayWake
            );
          }
        );
      },
      reserveDocumentTurn: (targetAgentId: string) => {
        requireOpen();
        if (typeof targetAgentId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(targetAgentId))
          throw new Error('DOCUMENT_RELAY_AGENT_ID_INVALID');
        // The exact instance also counts ordinary adapter dispatch. Do not create
        // another counter or call overridable public tryReserve/release methods.
        const accounting = dispatchTurnAccounting(context.documentTurnCeiling);
        const decision = accounting.reserve(`relay.agent.${targetAgentId}`);
        let refunded = false;
        return Object.freeze({
          allowed: decision.allowed,
          counted: decision.counted,
          scope: decision.scope,
          refundKnownNoStart() {
            if (refunded) return;
            refunded = true;
            decision.refund?.();
          },
        });
      },
      requireExplicitOpenerAccess: (openerAgentId: string, targetAgentId: string) => {
        requireOpen();
        // Neither caller-controlled subject strings nor the ordinary default allow are authority.
        const identifier = /^[A-Za-z0-9_-]{1,200}$/u;
        if (
          typeof openerAgentId !== 'string' ||
          typeof targetAgentId !== 'string' ||
          !identifier.test(openerAgentId) ||
          !identifier.test(targetAgentId)
        )
          throw new Error('DOCUMENT_RELAY_AGENT_ID_INVALID');
        const result = context.originalAccessCheck.call(
          accessControl,
          `relay.agent.${openerAgentId}`,
          `relay.agent.${targetAgentId}`
        );
        if (!result.allowed || result.matchedRule?.action !== 'allow')
          throw new Error('DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED');
      },
    })
  );
  return Object.freeze({ relay, origin });
}
