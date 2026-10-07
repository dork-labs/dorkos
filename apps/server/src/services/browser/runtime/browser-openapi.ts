import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import {
  BrowserHumanGrantRequestSchema,
  BrowserHumanGrantRevokeSchema,
  BrowserHumanStageRequestSchema,
  BrowserHumanStageReceiptSchema,
  BrowserHumanUploadRequestSchema,
  BrowserHumanDownloadRequestSchema,
  BrowserHumanDownloadReceiptSchema,
  BrowserHumanArtifactReadRequestSchema,
  BrowserHumanArtifactReceiptSchema,
  BrowserLocalDestinationRequestSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserDiagnosticsRequestSchema,
  BrowserDiagnosticSummarySchema,
  BrowserGrantSchema,
  BrowserActionReceiptSchema,
  BrowserBindingSchema,
  BrowserCloseReceiptSchema,
  BrowserCloseRequestSchema,
  BrowserControlSchema,
  BrowserCounterSchema,
  BrowserInputRequestSchema,
  BrowserInstanceSchema,
  BrowserNavigateRequestSchema,
  BrowserOpenRequestSchema,
  BrowserProductionEnableRequestSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserProductionNavigateRequestSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserProductionOpenRequestSchema,
  BrowserProductionProfileCreateReceiptSchema,
  BrowserProductionProfileImportRequestSchema,
  BrowserProductionProfileImportReceiptSchema,
  BrowserProductionProfileCreateRequestSchema,
  BrowserProductionStatusSchema,
  BrowserProfileSchema,
  BrowserReferenceSchema,
  BrowserRenderReceiptSchema,
  BrowserViewerSchema,
} from '@dorkos/shared/browser-schemas';

import {
  SemanticSnapshotV1Schema,
  SemanticReceiptV1Schema,
  SemanticActionV1Schema,
  SemanticEventV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import {
  BrowserCanvasPresentSchema,
  BrowserCanvasShareSchema,
  BrowserCanvasDeliverySchema,
  BrowserCanvasDetachSchema,
  BrowserCanvasDeliveryReceiptSchema,
  BrowserCanvasPresentReceiptSchema,
} from '@dorkos/shared/browser-canvas-schemas';

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const error = (description: string) => ({
  description,
  content: json(ErrorResponseSchema),
});
const tags = ['Managed browser'];
const owner =
  'Requires the current signed-in owner and an allowed request origin. ' +
  'This experiment is off by default and requires a verified installed browser runtime. ' +
  'The experiment must be enabled. Browser IDs and bindings do not grant permission. ' +
  'An unavailable response can also mean that current authority or native cleanup could not be proved.';
const grant = z
  .object({ grantId: BrowserReferenceSchema, revision: BrowserCounterSchema })
  .strict()
  .optional();
const localTicket = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,128}$/u)
  .optional();
const ticket = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const instanceParams = z.object({ browserId: BrowserReferenceSchema });
const generationQuery = z.object({
  browserGeneration: z
    .string()
    .regex(/^(0|[1-9]\d*)$/u)
    .transform(Number)
    .pipe(BrowserCounterSchema),
});

/** Register only the routes consumed by the current public startup composition.
 * Each optional route still requires the actual existing session and its separate grants.
 * @param registry - The server's original OpenAPI registry.
 */
export function registerBrowserOpenApi(registry: OpenAPIRegistry): void {
  const post = (
    path: string,
    summary: string,
    body: z.ZodType,
    response: z.ZodType,
    description = owner
  ) =>
    registry.registerPath({
      method: 'post',
      path: '/api/browser' + path,
      tags,
      summary,
      description,
      request: { body: { required: true, content: json(body) } },
      responses: {
        200: { description: 'The completed request', content: json(response) },
        ...(path !== '/runtime/enable'
          ? { 400: error('The request does not match the documented schema.') }
          : {}),
        ...(path === '/runtime/enable'
          ? { 403: error('The request host or origin was refused.') }
          : {}),
        503: error('The browser request is unavailable or could not complete safely.'),
      },
    });
  registry.registerPath({
    method: 'get',
    path: '/api/browser/runtime/status',
    tags,
    summary: 'Read whether the browser experiment is available',
    description:
      'Requires the current signed-in owner. Ready means startup admission, not an open browser or permission to act.',
    responses: {
      200: {
        description: 'Current experiment status',
        content: json(BrowserProductionStatusSchema),
      },
      403: error('The request host or origin was refused.'),
      503: error('Status could not be read safely.'),
    },
  });
  post(
    '/runtime/enable',
    'Turn the browser experiment on or off',
    BrowserProductionEnableRequestSchema,
    BrowserProductionStatusSchema,
    'Requires the current signed-in owner and an allowed request origin. Turning it off joins original browser cleanup. With enabled false, an optional chromeUserAgent choice is accepted only when no runtime transition or owned browser remains. Enabling does not grant workspace, viewer or controller permission.'
  );
  post(
    '/runtime/profiles/import',
    'Import sign-ins into a new saved profile',
    BrowserProductionProfileImportRequestSchema,
    BrowserProductionProfileImportReceiptSchema,
    'Requires the current signed-in owner, an allowed request origin and an authorized workspace. Accepts bounded cookies and local storage only. Always creates a new profile; it never seeds a clean browser or changes an existing profile. Availability requires original browser cleanup; failed imports remain quarantined.'
  );
  // Activation returns 403 for host/origin refusal; owner and input refusal return 503.
  registry.registerPath({
    method: 'post',
    path: '/api/browser/runtime/profiles',
    tags,
    summary: 'Create a saved browser profile',
    description: owner,
    request: {
      body: {
        required: true,
        content: json(BrowserProductionProfileCreateRequestSchema),
      },
    },
    responses: {
      200: {
        description: 'The saved profile',
        content: json(BrowserProductionProfileCreateReceiptSchema),
      },
      400: error('The profile name could not be read.'),
      503: error('The profile could not be created safely.'),
    },
  });
  post(
    '/runtime/local-destination',
    'Allow a local website for the current browser',
    BrowserLocalDestinationRequestSchema,
    BrowserLocalDestinationReceiptSchema,
    owner +
      ' The owner explicitly selects one local origin and a bounded lifetime; this does not grant control.'
  );
  post(
    '/runtime/open',
    'Open a browser in an owned workspace',
    BrowserProductionOpenRequestSchema,
    BrowserProductionOpenReceiptSchema
  );
  post(
    '/runtime/navigate',
    'Navigate the current controlled tab',
    BrowserProductionNavigateRequestSchema,
    BrowserProductionNavigateReceiptSchema
  );
  post(
    '/instances/close',
    'Close an owned browser generation',
    BrowserCloseRequestSchema,
    BrowserCloseReceiptSchema,
    owner +
      ' Success requires original native cleanup; removing metadata alone is not a successful close.'
  );
  post(
    '/control',
    'Request control of the current tab',
    BrowserBindingSchema,
    BrowserControlSchema
  );
  registry.registerPath({
    method: 'post',
    path: '/api/browser/workspaces/{workspaceId}/open',
    tags,
    summary: 'Open a browser in a specified owned workspace',
    description: owner,
    request: {
      params: z.object({ workspaceId: BrowserReferenceSchema }),
      body: { required: true, content: json(BrowserOpenRequestSchema) },
    },
    responses: {
      200: {
        description: 'The opened browser',
        content: json(BrowserInstanceSchema),
      },
      400: error('The workspace or browser request could not be read.'),
      503: error('The browser could not be opened safely.'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/browser/navigate',
    tags,
    summary: 'Navigate with a current controller header',
    description: owner,
    request: {
      headers: z.object({ 'x-browser-controller-id': BrowserReferenceSchema }),
      body: { required: true, content: json(BrowserNavigateRequestSchema) },
    },
    responses: {
      200: {
        description: 'The current tab binding after navigation',
        content: json(BrowserBindingSchema),
      },
      400: error('The command or controller header could not be read.'),
      503: error('Navigation could not complete safely.'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/browser/{browserId}/tabs',
    tags,
    summary: 'Read the current owned tab bindings',
    description: owner,
    request: { params: instanceParams, query: generationQuery },
    responses: {
      200: {
        description: 'The actual current bindings',
        content: json(z.array(BrowserBindingSchema).max(64)),
      },
      400: error('The browser generation could not be read.'),
      503: error('Current tab bindings are unavailable.'),
    },
  });
  const metadata = (
    path: string,
    summary: string,
    schema: z.ZodType,
    params?: z.ZodObject,
    query?: z.ZodObject
  ) =>
    registry.registerPath({
      method: 'get',
      path: '/api/browser' + path,
      tags,
      summary,
      description:
        'Returns only records belonging to the current human caller. Saved metadata does not prove a live native browser.',
      request: { ...(params ? { params } : {}), ...(query ? { query } : {}) },
      responses: {
        200: { description: 'The owned records', content: json(schema) },
        400: error('The reference or generation could not be read.'),
        401: error('Sign in to access the browser.'),
        404: error('The record is unavailable to this caller.'),
        500: error('The record could not be read.'),
        503: error('The browser is unavailable.'),
      },
    });
  metadata(
    '/profiles',
    'List owned saved profiles',
    z.object({ profiles: z.array(BrowserProfileSchema) })
  );
  metadata(
    '/profiles/{profileId}',
    'Read an owned saved profile',
    BrowserProfileSchema,
    z.object({ profileId: BrowserReferenceSchema })
  );
  metadata(
    '/instances',
    'List owned browser generations',
    z.object({ instances: z.array(BrowserInstanceSchema) })
  );
  metadata(
    '/instances/{browserId}',
    'Read an owned browser generation',
    BrowserInstanceSchema,
    instanceParams,
    generationQuery
  );
  const delivery = (
    path: string,
    summary: string,
    body: z.ZodType,
    content: ReturnType<typeof json> | Record<string, { schema: z.ZodType }>
  ) =>
    registry.registerPath({
      method: 'post',
      path: '/api/browser' + path,
      tags,
      summary,
      description:
        'Requires fresh viewer or controller admission for the same browser and tab. ' +
        'Keep tickets in memory and request bodies only. Never put tickets in a URL or persistent storage. ' +
        'Viewer permission never grants input permission.',
      request: { body: { required: true, content: json(body) } },
      responses: {
        200: { description: 'The original delivery result', content },
        400: error('The delivery request could not be read.'),
        ...(path === '/input'
          ? { 403: error('Controller authority was refused.') }
          : {
              401: error('Sign in to access the browser.'),
              500: error('The original delivery could not complete.'),
            }),
        404: error('The current binding or ticket is unavailable.'),
        503: error('The browser is unavailable or at capacity.'),
      },
    });
  delivery(
    '/viewers/issue',
    'Issue a viewer ticket',
    z.object({ binding: BrowserBindingSchema, grant, localTicket }).strict(),
    json(z.object({ viewer: BrowserViewerSchema, ticket }).strict())
  );
  delivery(
    '/viewers/next',
    'Read the next viewer frame',
    z
      .object({
        ticket,
        receipt: BrowserRenderReceiptSchema.optional(),
        localTicket,
      })
      .strict(),
    {
      'application/vnd.dorkos.browser-frame': {
        schema: z.string().openapi({
          format: 'binary',
          description:
            'Bounded browser-frame wire body: metadata and JPEG bytes. Echo only the actual displayed render receipt in the next request.',
        }),
      },
    }
  );
  delivery(
    '/viewers/disconnect',
    'Disconnect an original viewer',
    z.object({ ticket, localTicket }).strict(),
    json(z.object({}).strict())
  );
  delivery(
    '/input',
    'Send input through the current controller',
    z
      .object({
        command: BrowserInputRequestSchema,
        controllerId: BrowserReferenceSchema,
        grant,
        localTicket,
      })
      .strict(),
    json(BrowserActionReceiptSchema)
  );
  const optional = (
    path: string,
    summary: string,
    body: z.ZodType,
    response: z.ZodType,
    responses: Record<string, ReturnType<typeof error> | { description: string }>
  ) =>
    registry.registerPath({
      method: 'post',
      path: '/api/browser' + path,
      tags,
      summary,
      description:
        'Selects only an existing live browser session. The original request must pass fresh caller, origin, binding and capability checks. A reference alone grants no permission.',
      request: { body: { required: true, content: json(body) } },
      responses: {
        200: { description: 'The authorized result', content: json(response) },
        ...responses,
      },
    });
  const semanticScope = z.object({ binding: BrowserBindingSchema, grant }).strict();
  const semanticFailures = {
    404: error('The existing browser is unavailable.'),
    503: error('The page request could not complete with current permission.'),
  };
  for (const ownerRoute of [false, true]) {
    const prefix = `/semantic/${ownerRoute ? 'owner/' : ''}`;
    optional(
      prefix + 'read',
      'Read the current page outline',
      semanticScope,
      SemanticSnapshotV1Schema,
      semanticFailures
    );
    optional(
      prefix + 'action',
      'Act on the current page outline',
      semanticScope
        .extend({
          controllerId: BrowserReferenceSchema,
          request: SemanticActionV1Schema,
          confirmSecret: z.literal(true).optional(),
        })
        .strict(),
      SemanticReceiptV1Schema,
      semanticFailures
    );
    const streamScope = semanticScope.extend({ leaseId: BrowserReferenceSchema }).strict();
    optional(
      prefix + 'stream',
      'Start current page outline updates',
      streamScope,
      z.object({ eventStreamId: BrowserReferenceSchema }).strict(),
      semanticFailures
    );
    const streamCommand = streamScope.extend({ streamId: BrowserReferenceSchema }).strict();
    optional(
      prefix + 'next',
      'Read the next page outline update',
      streamCommand,
      SemanticEventV1Schema.nullable(),
      semanticFailures
    );
    optional(
      prefix + 'close',
      'Close page outline updates',
      streamCommand,
      z.object({ closed: z.literal(true) }).strict(),
      semanticFailures
    );
  }
  optional(
    '/diagnostics',
    'Read granted browser diagnostics',
    BrowserDiagnosticsRequestSchema,
    BrowserDiagnosticSummarySchema,
    {
      400: error('The diagnostics request could not be read.'),
      404: error('The browser or diagnostics permission is unavailable.'),
      503: error('The diagnostics request could not complete.'),
    }
  );
  const fileFailures = {
    400: error('The file request could not be read.'),
    404: error('The original browser, artifact or required permission is unavailable.'),
    503: error('The file operation could not be confirmed.'),
  };
  optional(
    '/files/grant',
    'Grant yourself file or diagnostics access',
    BrowserHumanGrantRequestSchema,
    BrowserGrantSchema,
    fileFailures
  );
  optional(
    '/files/revoke',
    'Revoke your file or diagnostics grant',
    BrowserHumanGrantRevokeSchema,
    BrowserGrantSchema,
    fileFailures
  );
  optional(
    '/files/stage',
    'Stage a file for upload (up to 512 KiB)',
    BrowserHumanStageRequestSchema,
    BrowserHumanStageReceiptSchema,
    fileFailures
  );
  optional(
    '/files/upload',
    'Choose a staged file for the current page',
    BrowserHumanUploadRequestSchema,
    BrowserActionReceiptSchema,
    fileFailures
  );
  optional(
    '/files/download',
    'Download an explicitly granted page response',
    BrowserHumanDownloadRequestSchema,
    BrowserHumanDownloadReceiptSchema,
    fileFailures
  );
  optional(
    '/files/read',
    'Read an owned staged artifact',
    BrowserHumanArtifactReadRequestSchema,
    BrowserHumanArtifactReceiptSchema,
    fileFailures
  );
  const canvasFailures = {
    400: {
      description: 'The Canvas command could not be read. The response body is empty.',
    },
    403: {
      description:
        'The request origin or current caller permission was refused. The response body is empty.',
    },
    // The mounted session selector reports missing bindings/attachments as JSON before the child route.
    404: error('The session selector could not find the exact presentation or browser.'),
    503: {
      description:
        'The Canvas command is unavailable. The child route returns an empty body; the outer runtime admission may return a JSON error.',
    },
  };
  optional(
    '/canvas/present',
    'Present the current browser in Canvas',
    BrowserCanvasPresentSchema,
    BrowserCanvasPresentReceiptSchema,
    canvasFailures
  );
  optional(
    '/canvas/share',
    'Grant access to an existing browser presentation',
    BrowserCanvasShareSchema,
    BrowserGrantSchema,
    canvasFailures
  );
  optional(
    '/canvas/delivery',
    'Resolve current access to a browser presentation',
    BrowserCanvasDeliverySchema,
    BrowserCanvasDeliveryReceiptSchema,
    canvasFailures
  );
  optional(
    '/canvas/detach',
    'Remove an owned browser presentation',
    BrowserCanvasDetachSchema,
    z.object({}).strict(),
    canvasFailures
  );
}
