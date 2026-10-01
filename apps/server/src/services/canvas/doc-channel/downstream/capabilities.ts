/** Shared capability bodies for every runtime; composition owns registration and generated contracts. */
import { z } from 'zod';
import {
  CanvasChannelSendRequestSchema,
  CanvasChannelPatchStateRequestSchema,
  CanvasChannelPatchStateReceiptSchema,
  IngestReceiptSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  defineCapability,
  type CapabilityDefinition,
  type CapabilityHandlerContext,
} from '../../../core/capabilities/index.js';
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import type { DocChannelActor } from '../authorization.js';
import { DocChannelDownstream, DocDownstreamError } from './service.js';

function actor(context: CapabilityHandlerContext): DocChannelActor {
  if (!isServerPrincipal(context.serverPrincipal))
    throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
  return { surface: 'capability', principal: context.serverPrincipal };
}
/** Build act-tier bodies over the authoritative service, without any runtime-specific SDK or direct registration. */
export function createDocChannelDownstreamCapabilities(
  service: DocChannelDownstream
): CapabilityDefinition[] {
  return [
    defineCapability({
      id: 'ui.send_canvas_event',
      title: 'Send a document event',
      description:
        'Save an event for this document. The receipt confirms storage. An app acknowledgment settles only its named inputs.',
      tier: 'act',
      area: null,
      areaNote: 'current document write scope or exact granted responder for app acknowledgments',
      input: CanvasChannelSendRequestSchema,
      output: z.object({ receipt: IngestReceiptSchema }).strict(),
      surfaces: { mcp: { toolName: 'canvas_send', servers: ['in-session', 'external'] } },
      invoke: async (_deps, input, context) => service.send(input, actor(context)),
    }),
    defineCapability({
      id: 'ui.patch_canvas_state',
      title: 'Patch document state',
      description:
        'Update this document’s live JSON state at the expected revision. Editable content and the editing lock stay intact.',
      tier: 'act',
      area: null,
      areaNote: 'current document-scoped write authority',
      input: CanvasChannelPatchStateRequestSchema,
      output: CanvasChannelPatchStateReceiptSchema,
      surfaces: { mcp: { toolName: 'canvas_patch_state', servers: ['in-session', 'external'] } },
      invoke: async (_deps, input, context) => service.patchState(input, actor(context)),
    }),
  ];
}
