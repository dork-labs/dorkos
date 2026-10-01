/** Typed document route operations, deliberately not registered at composition here. */
import { z } from 'zod';
import { CanvasChannelDeclarationSchema } from '@dorkos/shared/canvas-channel-schemas';
import {
  defineCapability,
  type CapabilityDefinition,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import { isServerPrincipal } from '../../connectors/principal/server-principal.js';
import {
  DocRouteGrantError,
  DocRouteGrantRequestSchema,
  type DocGrantActor,
} from './grant-policy.js';
import type { DocChannelGrants } from './grants.js';

function actorOf(context: CapabilityHandlerContext): DocGrantActor {
  if (!isServerPrincipal(context.serverPrincipal))
    throw new DocRouteGrantError('INVALID_PRINCIPAL');
  return { surface: 'capability', principal: context.serverPrincipal };
}
/**
 * Build implementations for the existing UI domain. The route's independent
 * approval is consumed by the service, never inferred from a registry permission.
 */
export function createDocChannelGrantCapabilities(
  service: DocChannelGrants
): CapabilityDefinition[] {
  return [
    defineCapability({
      id: 'ui.configure_doc_channel',
      title: 'Set document event routes',
      description:
        'Declare which document events may reach an agent. Declaring a route does not approve it or resend old events.',
      tier: 'act',
      area: null,
      areaNote: 'document-scoped declarations with independent exact route grants',
      input: z
        .object({
          documentId: z.string().min(1).max(200),
          channel: CanvasChannelDeclarationSchema,
          openerAgentId: z.string().min(1).max(200).optional(),
        })
        .strict(),
      output: z.object({ configured: z.literal(true) }).strict(),
      surfaces: { mcp: { toolName: 'configure_doc_channel', servers: ['in-session'] } },
      invoke: async (_deps, input, context) => {
        service.configure(input.documentId, input.channel, actorOf(context), input.openerAgentId);
        return { configured: true as const };
      },
    }),
    defineCapability({
      id: 'ui.approve_doc_route',
      title: 'Allow a document event route',
      description:
        'Enable an exact document route. Your own route needs your verified identity. Other targets and file writes need a matching approval.',
      tier: 'act',
      area: null,
      areaNote: 'independent operator approval binds each exact route and target',
      input: DocRouteGrantRequestSchema.extend({
        routeApprovalToken: z.string().min(1).max(200).optional(),
      }).strict(),
      output: z.union([
        z
          .object({
            kind: z.literal('granted'),
            grantId: z.string(),
            revision: z.number().int().positive(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('approval_required'),
            ticket: z
              .object({
                approvalId: z.string(),
                token: z.string(),
                expiresAt: z.string(),
              })
              .strict(),
          })
          .strict(),
      ]),
      surfaces: { mcp: { toolName: 'approve_doc_route', servers: ['in-session'] } },
      invoke: async (_deps, input, context) => {
        const { routeApprovalToken, ...request } = input;
        const result = service.grant(request, actorOf(context), routeApprovalToken);
        return result.kind === 'granted'
          ? { kind: result.kind, grantId: result.grant.grantId, revision: result.grant.revision }
          : result;
      },
    }),
    defineCapability({
      id: 'ui.revoke_doc_route',
      title: 'Stop a document event route',
      description:
        'Revoke a document route so future events cannot start work. Work already started keeps its recorded source.',
      tier: 'act',
      area: null,
      areaNote: 'verified document opener or operator removes existing route authority',
      input: z
        .object({ documentId: z.string().min(1).max(200), grantId: z.string().min(1).max(200) })
        .strict(),
      output: z.object({ revoked: z.literal(true) }).strict(),
      surfaces: { mcp: { toolName: 'revoke_doc_route', servers: ['in-session'] } },
      invoke: async (_deps, input, context) => {
        service.revoke(input.documentId, input.grantId, actorOf(context));
        return { revoked: true as const };
      },
    }),
  ];
}
