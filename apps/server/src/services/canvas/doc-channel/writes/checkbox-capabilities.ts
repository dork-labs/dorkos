/** Native task writes shared by the in-session and authenticated external MCP surfaces. */
import {
  CanvasChannelCheckboxRequestSchema,
  CanvasChannelCheckboxReceiptSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  defineCapability,
  type CapabilityDefinition,
  type CapabilityDeps,
} from '../../../core/capabilities/capability-definition.js';
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocDownstreamError } from '../downstream/service.js';
import { toggleOriginalCheckboxWriter, type DocCheckboxWriteService } from './checkbox-service.js';
import { isCheckboxAuthorityRefusal } from './authority-policy.js';

declare module '../../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The same original installation child used by the ordinary native checkbox endpoint. */
    docChannelCheckboxWriter?: DocCheckboxWriteService;
  }
}
/** Declare a task mutation over the original installed writer; registration grants no filesystem authority. */
export function createDocChannelCheckboxCapabilities(
  writer?: DocCheckboxWriteService
): CapabilityDefinition[] {
  return [
    defineCapability({
      id: 'ui.set_canvas_checkbox',
      title: 'Set a native document task',
      description:
        'Set the requested done value on one mapped native file task. Supply its current file version and exact line hash. Retry a lost response with the same event ID. The receipt confirms the file write, separately from dispatch, runtime completion, or app acknowledgment.',
      tier: 'act',
      area: null,
      areaNote: 'current native document editor and original operator-approved write route',
      input: CanvasChannelCheckboxRequestSchema,
      output: CanvasChannelCheckboxReceiptSchema,
      surfaces: { mcp: { toolName: 'canvas_set_checkbox', servers: ['in-session', 'external'] } },
      invoke: async (deps: CapabilityDeps, input, context) => {
        const original = writer ?? deps.docChannelCheckboxWriter;
        if (!original) throw new DocDownstreamError('DOC_CHANNEL_UNAVAILABLE', 503);
        if (!isServerPrincipal(context.serverPrincipal))
          throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
        try {
          return await toggleOriginalCheckboxWriter(original, input, {
            surface: 'capability',
            principal: context.serverPrincipal,
          });
        } catch (cause) {
          if (
            isCheckboxAuthorityRefusal(cause) &&
            cause &&
            typeof cause === 'object' &&
            'code' in cause &&
            typeof cause.code === 'string'
          )
            throw new DocDownstreamError(cause.code, 403);
          throw cause;
        }
      },
    }),
  ];
}
