/** Explicit operator document management over the same service's native current engine. */
import { z } from 'zod';
import {
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelBatchReplayResultSchema,
  CanvasChannelManagementSnapshotSchema,
  CanvasChannelTokenRequestSchema,
  CanvasChannelTokenResponseSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  defineCapability,
  type CapabilityDeps,
} from '../../../core/capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../../../core/capabilities/registry.js';
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocRouteGrantError } from '../grant-policy.js';
import {
  replayServiceOriginalExpiredDocBatch,
  readServiceOriginalDocManagement,
  issueServiceOriginalDocToken,
  revokeServiceOriginalDocToken,
  type DocChannelService,
} from '../service.js';

declare module '../../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    docChannelManagementService?: DocChannelService;
    docChannelManagementFileWrites?: import('../writes/installation-file-writes.js').InstallationFileWrites;
  }
}
function operator(context: CapabilityHandlerContext) {
  if (
    !isServerPrincipal(context.serverPrincipal) ||
    context.serverPrincipal.claims.kind !== 'operator'
  )
    throw new DocRouteGrantError('INVALID_PRINCIPAL');
  return { surface: 'capability' as const, principal: context.serverPrincipal };
}
function service(deps: CapabilityDeps) {
  if (!deps.docChannelManagementService) throw new DocRouteGrantError('DOC_CHANNEL_UNAVAILABLE');
  return deps.docChannelManagementService;
}
/** Generate capability surfaces from the original typed operator operations, without a caller authority callback. */
export function createDocChannelManagementCapabilities() {
  return [
    defineCapability({
      id: 'ui.replay_doc_batch',
      title: 'Replay reviewed document work',
      tier: 'act',
      area: null,
      areaNote: 'explicit expired, never-admitted session or original Room work only',
      description:
        'After explicit review, create one new generation from retained original chat or Room inputs. Admitted, acknowledged, uncertain and consumed work cannot be repeated.',
      input: CanvasChannelBatchReplayRequestSchema,
      output: CanvasChannelBatchReplayResultSchema,
      surfaces: { mcp: { toolName: 'replay_doc_batch', servers: ['in-session'] } },
      invoke: async (deps, input, context) => {
        const actor = operator(context);
        return replayServiceOriginalExpiredDocBatch(service(deps), input, actor);
      },
    }),
    defineCapability({
      id: 'ui.inspect_doc_channel',
      title: 'Inspect document routes',
      tier: 'observe',
      area: null,
      areaNote: 'current document operator metadata',
      description:
        'Read declarations, recorded grants, token metadata and work requiring review. Metadata does not approve a route or replay work.',
      input: z.object({ documentId: z.string().min(1).max(200) }).strict(),
      output: CanvasChannelManagementSnapshotSchema,
      surfaces: { mcp: { toolName: 'inspect_doc_channel', servers: ['in-session'] } },
      invoke: async (deps, input, context) => {
        const actor = operator(context);
        return readServiceOriginalDocManagement(service(deps), input.documentId, actor);
      },
    }),
    defineCapability({
      id: 'ui.issue_doc_token',
      title: 'Create a document token',
      tier: 'act',
      area: null,
      areaNote: 'explicit native document token scope without route creation',
      description:
        'Create one standalone document credential with explicit types, directions, permissions and expiry. Reveal it once; never place it in content or a URL.',
      input: z
        .object({
          request: CanvasChannelTokenRequestSchema,
          approvedGrantIds: z
            .array(z.string().min(1).max(200))
            .max(1024)
            .refine((ids) => new Set(ids).size === ids.length),
        })
        .strict(),
      output: CanvasChannelTokenResponseSchema,
      surfaces: { mcp: { toolName: 'issue_doc_token', servers: ['in-session'] } },
      invoke: async (deps, input, context) => {
        const actor = operator(context);
        return CanvasChannelTokenResponseSchema.parse(
          await issueServiceOriginalDocToken(
            service(deps),
            actor,
            input.request,
            input.approvedGrantIds
          )
        );
      },
    }),
    defineCapability({
      id: 'ui.revoke_doc_token',
      title: 'Revoke a document token',
      tier: 'act',
      area: null,
      areaNote: 'original document operator revocation',
      description:
        'Revoke a standalone credential and close its active streams. A document bearer cannot authorize this operation.',
      input: z
        .object({ documentId: z.string().min(1).max(200), tokenId: z.string().min(1).max(200) })
        .strict(),
      output: z
        .object({
          tokenId: z.string().min(1).max(200),
          revokedAt: z.string().datetime({ offset: true }),
        })
        .strict(),
      surfaces: { mcp: { toolName: 'revoke_doc_token', servers: ['in-session'] } },
      invoke: async (deps, input, context) => {
        const actor = operator(context);
        return revokeServiceOriginalDocToken(service(deps), actor, input.documentId, input.tokenId);
      },
    }),
  ];
}
