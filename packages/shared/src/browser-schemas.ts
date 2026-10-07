import { BrowserStorageStateSchema } from './browser-storage-state-schemas.js';
export {
  BrowserStorageStateSchema,
  type BrowserStorageState,
} from './browser-storage-state-schemas.js';
import { createBrowserCaptureSchemas } from './browser-capture-schemas.js';
/** Strict browser-safe managed-browser projections. Parsing never authorizes an actor or activates a runtime. */
import { z } from 'zod';
import { SemanticActionV1Schema } from './browser-semantic-schemas.js';
import {
  boundedBrowserJson,
  BrowserCounterSchema as counter,
  BrowserReferenceSchema as ref,
  BrowserTimestampSchema,
  browserText,
  browserPlainText,
} from './browser-schema-json.js';
export * from './browser-semantic-schemas.js';
export { BrowserCounterSchema, BrowserReferenceSchema } from './browser-schema-json.js';

const bindingShape = {
  browserId: ref,
  browserGeneration: counter,
  tabId: ref,
  navigationGeneration: counter,
  viewportVersion: counter,
  epoch: counter,
  inputGeneration: counter,
};
/** Full canonical input/capture binding; references and counters confer no permission. */
export const BrowserBindingSchema = boundedBrowserJson(z.object(bindingShape).strict());
/** Explicit permission vocabulary; service checks effective grants independently. */
export const BrowserPermissionSchema = z.enum([
  'browser.view',
  'browser.control',
  'browser.secretInput',
  'browser.diagnostics',
  'browser.download',
  'browser.upload',
  'browser.artifact',
  'browser.manageProfile',
]);
const permissions = z
  .array(BrowserPermissionSchema)
  .min(1)
  .max(8)
  .refine((items) => new Set(items).size === items.length);
/** Scoped attachment reference; room/session membership alone grants no browser access. */
export const BrowserAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: ref }).strict(),
  z.object({ kind: z.literal('room'), roomId: ref }).strict(),
]);
/** Server-issued grant projection excludes credentials and private account state. */
export const BrowserGrantSchema = boundedBrowserJson(
  z
    .object({
      grantId: ref,
      grantRevision: counter,
      tabId: ref,
      attachment: BrowserAttachmentSchema,
      permissions,
      expiresAt: BrowserTimestampSchema,
      revokedAt: BrowserTimestampSchema.nullable(),
    })
    .strict()
);
/** Grant update names existing authority; its caller identity comes only from credentials. */
export const BrowserGrantChangeRequestSchema = boundedBrowserJson(
  z
    .object({
      grantId: ref,
      expectedRevision: counter,
      permissions,
      expiresAt: BrowserTimestampSchema,
    })
    .strict()
);
/** Named profile metadata, with no storage path, cookies or native profile handle. */
export const BrowserProfileSchema = boundedBrowserJson(
  z
    .object({
      profileId: ref,
      label: browserPlainText(512),
      revision: counter,
      status: z.enum(['available', 'inUse', 'quarantined']),
    })
    .strict()
);
/** Explicit retained or separate unseeded clean acquisition request. */
export const BrowserOpenRequestSchema = boundedBrowserJson(
  z.discriminatedUnion('mode', [
    z.object({ requestId: ref, mode: z.literal('persistent'), profileId: ref }).strict(),
    z.object({ requestId: ref, mode: z.literal('ephemeral') }).strict(),
  ])
);
/** Live/stopped projection, distinct from a durable profile or viewer lifetime. */
export const BrowserInstanceSchema = boundedBrowserJson(
  z.discriminatedUnion('mode', [
    z
      .object({
        browserId: ref,
        browserGeneration: counter,
        mode: z.literal('persistent'),
        profileId: ref,
        status: z.enum(['opening', 'running', 'stopping', 'stopped', 'uncertain']),
      })
      .strict(),
    z
      .object({
        browserId: ref,
        browserGeneration: counter,
        mode: z.literal('ephemeral'),
        status: z.enum(['opening', 'running', 'stopping', 'stopped', 'uncertain']),
      })
      .strict(),
  ])
);
/** A canonical tab uses a fixed viewport; viewer scaling cannot silently alter it. */
export const BrowserTabSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      status: z.enum(['running', 'stopped']),
      viewport: z
        .object({
          width: z.number().int().min(1).max(16384),
          height: z.number().int().min(1).max(16384),
        })
        .strict(),
    })
    .strict()
);
/** Explicit stop request contains no engine identity or process capability. */
export const BrowserCloseRequestSchema = boundedBrowserJson(
  z.object({ requestId: ref, browserId: ref, browserGeneration: counter }).strict()
);
/** Stop outcome distinguishes observed disappearance from failed or unavailable cleanup. */
export const BrowserCloseReceiptSchema = boundedBrowserJson(
  z.union([
    z
      .object({
        requestId: ref,
        browserId: ref,
        browserGeneration: counter,
        cleanup: z.literal('observed'),
      })
      .strict(),
    z
      .object({
        requestId: ref,
        browserId: ref,
        browserGeneration: counter,
        cleanup: z.enum(['failed', 'unverified']),
        reason: z.enum(['processesRemain', 'observationUnavailable', 'closeFailed']),
      })
      .strict(),
  ])
);
/** Server-issued controller state; actor identity and transition authorization are not body fields. */
export const BrowserControlSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      controllerId: ref.nullable(),
      status: z.enum(['ready', 'barrier', 'stopped']),
    })
    .strict()
);
/** Disposable viewer reference contains no stream credentials or authority ticket. */
export const BrowserViewerSchema = boundedBrowserJson(
  z
    .object({
      viewerId: ref,
      binding: BrowserBindingSchema,
      expiresAt: BrowserTimestampSchema,
    })
    .strict()
);
/** Capture request binds the canonical Page without asking for private engine objects. */
export const BrowserCaptureRequestSchema = boundedBrowserJson(
  z.object({ requestId: ref, binding: BrowserBindingSchema }).strict()
);
const coordinate = z.number().finite().min(0).max(16384);
const button = z.enum(['left', 'middle', 'right']);
const key = z.enum([
  'Tab',
  'Enter',
  'Space',
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
]);
/** Structured bounded pixel/keyboard steps, excluding selectors, evaluation and executable commands. */
export const BrowserInputStepSchema = boundedBrowserJson(
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('click'),
        x: coordinate,
        y: coordinate,
        button,
      })
      .strict(),
    z.object({ kind: z.literal('mouseMove'), x: coordinate, y: coordinate }).strict(),
    z.object({ kind: z.literal('mouseDown'), button }).strict(),
    z.object({ kind: z.literal('mouseUp'), button }).strict(),
    z.object({ kind: z.literal('keyDown'), key }).strict(),
    z.object({ kind: z.literal('keyUp'), key }).strict(),
    z.object({ kind: z.literal('text'), text: browserText(2048) }).strict(),
    z
      .object({
        kind: z.literal('composition'),
        text: browserText(2048),
        selectionStart: z.number().int().nonnegative().max(2048),
        selectionEnd: z.number().int().nonnegative().max(2048),
      })
      .strict()
      .refine(
        (value) =>
          value.selectionStart <= value.selectionEnd && value.selectionEnd <= value.text.length
      ),
    z.object({ kind: z.literal('compositionCommit'), text: browserText(2048) }).strict(),
    z
      .object({
        kind: z.literal('wheel'),
        deltaX: z.number().finite().min(-16384).max(16384),
        deltaY: z.number().finite().min(-16384).max(16384),
      })
      .strict(),
  ])
);
/** Managed input request; expanded click steps count toward the sixteen-step bound. */
export const BrowserInputRequestSchema = boundedBrowserJson(
  z
    .object({
      kind: z.literal('input'),
      requestId: ref,
      binding: BrowserBindingSchema,
      steps: z.array(BrowserInputStepSchema).min(1).max(16),
    })
    .strict()
    .refine(
      (value) =>
        value.steps.reduce((count, step) => count + (step.kind === 'click' ? 3 : 1), 0) <= 16
    )
);
/** Navigation validates URL syntax only; destination policy remains mandatory at dispatch. */
export const BrowserNavigateRequestSchema = boundedBrowserJson(
  z
    .object({
      kind: z.literal('navigate'),
      requestId: ref,
      binding: BrowserBindingSchema,
      url: z
        .string()
        .max(2048)
        .refine((value) => {
          if (value === 'about:blank') return true;
          try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
          } catch {
            return false;
          }
        }),
    })
    .strict()
);
/** Closed structured actions, including the independently versioned semantic lane. */
export const BrowserActionRequestSchema = z.union([
  BrowserInputRequestSchema,
  BrowserNavigateRequestSchema,
  SemanticActionV1Schema,
]);
/** Closed public error metadata; no underlying message, path, URL, stderr or input echo. */
export const BrowserErrorSchema = boundedBrowserJson(
  z
    .object({
      version: z.literal(1),
      reason: z.enum([
        'inaccessible',
        'invalidRequest',
        'versionMismatch',
        'notInstalled',
        'runtimeUnavailable',
        'networkPolicyUnsupported',
        'profileInUse',
        'profileUncertain',
        'staleBinding',
        'stopped',
        'queueFull',
        'deadline',
        'resetFailed',
        'dispatchFailed',
        'responseLost',
        'policyRefused',
      ]),
    })
    .strict()
);
/** Attributed action outcome, never an assertion that a site committed or persisted a change. */
export const BrowserActionReceiptSchema = boundedBrowserJson(
  z.union([
    z
      .object({
        requestId: ref,
        binding: BrowserBindingSchema,
        outcome: z.literal('completed'),
      })
      .strict(),
    z
      .object({
        requestId: ref,
        binding: BrowserBindingSchema,
        outcome: z.enum(['rejected', 'aborted', 'uncertain']),
        reason: BrowserErrorSchema,
      })
      .strict(),
  ])
);
const frameShape = {
  binding: BrowserBindingSchema,
  viewerId: ref,
  frameId: ref,
  sequence: counter,
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024),
  format: z.enum(['jpeg', 'png']),
};
/** Lossy non-durable frame metadata; bytes travel separately and must match this admitted frame. */
export const BrowserFrameSchema = boundedBrowserJson(z.object(frameShape).strict());
/** Claimed decoded-and-drawn frame acknowledgment; the service must verify prior delivery and replay protection. */
export const BrowserRenderReceiptSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      viewerId: ref,
      frameId: ref,
      sequence: counter,
      stage: z.literal('drawn'),
      drawnAt: BrowserTimestampSchema,
    })
    .strict()
);
/** Correlate a draw claim to supplied frame metadata; this cannot prove actual browser rendering. */
export const BrowserFrameAcknowledgmentSchema = boundedBrowserJson(
  z
    .object({ frame: BrowserFrameSchema, receipt: BrowserRenderReceiptSchema })
    .strict()
    .refine(
      ({ frame, receipt }) =>
        frame.viewerId === receipt.viewerId &&
        frame.frameId === receipt.frameId &&
        frame.sequence === receipt.sequence &&
        (Object.keys(frame.binding) as (keyof typeof frame.binding)[]).every(
          (key) => frame.binding[key] === receipt.binding[key]
        )
    )
);
/** Bounded diagnostic metadata deliberately omits console/network/page payloads and generic detail strings. */
export const BrowserDiagnosticSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      requestId: ref.optional(),
      capturedAt: BrowserTimestampSchema,
      kind: z.enum(['console', 'network', 'lifecycle']),
      code: z.enum(['observed', 'dropped', 'redacted', 'unavailable']),
      count: counter,
      truncated: z.boolean(),
      redacted: z.boolean(),
    })
    .strict()
);

/** New negotiated projections; existing binding/frame/ACK schema identities stay unchanged. */
export const { BrowserFramePointerEnvelopeSchema, BrowserDiagnosticSummarySchema } =
  createBrowserCaptureSchemas({
    binding: BrowserBindingSchema,
    frame: BrowserFrameSchema,
  });
/** Exact inferred capture geometry projection. */
export type BrowserFramePointerEnvelope = z.infer<typeof BrowserFramePointerEnvelopeSchema>;
/** Exact inferred scalar diagnostic summary. */
export type BrowserDiagnosticSummary = z.infer<typeof BrowserDiagnosticSummarySchema>;

/** Canonical Page binding. */
export type BrowserBinding = z.infer<typeof BrowserBindingSchema>;
/** Explicit permission name. */
export type BrowserPermission = z.infer<typeof BrowserPermissionSchema>;
/** Scope attachment. */
export type BrowserAttachment = z.infer<typeof BrowserAttachmentSchema>;
/** Server-issued grant metadata. */
export type BrowserGrant = z.infer<typeof BrowserGrantSchema>;
/** Existing grant update. */
export type BrowserGrantChangeRequest = z.infer<typeof BrowserGrantChangeRequestSchema>;
/** Durable profile metadata. */
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;
/** Browser acquisition request. */
export type BrowserOpenRequest = z.infer<typeof BrowserOpenRequestSchema>;
/** Browser lifetime metadata. */
export type BrowserInstance = z.infer<typeof BrowserInstanceSchema>;
/** Tab metadata. */
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
/** Stop request. */
export type BrowserCloseRequest = z.infer<typeof BrowserCloseRequestSchema>;
/** Pixel/keyboard step. */
export type BrowserInputStep = z.infer<typeof BrowserInputStepSchema>;
/** Pixel/keyboard request. */
export type BrowserInputRequest = z.infer<typeof BrowserInputRequestSchema>;
/** Navigation request. */
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequestSchema>;
/** Managed action request. */
export type BrowserActionRequest = z.infer<typeof BrowserActionRequestSchema>;
/** Public failure metadata. */
export type BrowserError = z.infer<typeof BrowserErrorSchema>;
/** Managed action result. */
export type BrowserActionReceipt = z.infer<typeof BrowserActionReceiptSchema>;
/** Frame metadata. */
export type BrowserFrame = z.infer<typeof BrowserFrameSchema>;
/** Draw claim, subject to delivery validation. */
export type BrowserRenderReceipt = z.infer<typeof BrowserRenderReceiptSchema>;
/** Supplied frame/receipt correlation. */
export type BrowserFrameAcknowledgment = z.infer<typeof BrowserFrameAcknowledgmentSchema>;
/** Payload-free diagnostic projection. */
export type BrowserDiagnostic = z.infer<typeof BrowserDiagnosticSchema>;

/** Stop outcome. */
export type BrowserCloseReceipt = z.infer<typeof BrowserCloseReceiptSchema>;
/** Server-issued controller state. */
export type BrowserControl = z.infer<typeof BrowserControlSchema>;
/** Disposable viewer metadata. */
export type BrowserViewer = z.infer<typeof BrowserViewerSchema>;
/** Canonical capture request. */
export type BrowserCaptureRequest = z.infer<typeof BrowserCaptureRequestSchema>;

/** Initial document URL for a newly acquired clean browser, before any controller/input.
 * Native ordinary policy and protected egress admission remain independent required checks. */
export const BrowserProductionInitialUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
      );
    } catch {
      return false;
    }
  });
/** Explicit clean or existing named-profile acquisition; no caller path or storage seeding. */
export const BrowserProductionOpenRequestSchema = boundedBrowserJson(
  z
    .object({
      workspaceId: ref,
      initialUrl: BrowserProductionInitialUrlSchema.optional(),
      request: BrowserOpenRequestSchema,
    })
    .strict()
);
/** Actual original acquisition correlation; a response cannot select a different instance/binding. */
export const BrowserProductionOpenReceiptSchema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      instance: BrowserInstanceSchema,
      binding: BrowserBindingSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.instance.status === 'running' &&
        value.instance.browserId === value.binding.browserId &&
        value.instance.browserGeneration === value.binding.browserGeneration,
      'Browser acquisition does not match its current binding'
    )
);
/** Actual production owner projection. Stored enabled/capability presence never imply this ready
 * branch means verified startup-mode admission, not an acquired Page; each open must freshly acquire original incoming actor/native/lease/config authority. */
export const BrowserProductionStatusSchema = boundedBrowserJson(
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('disabled'), enabled: z.literal(false) }).strict(),
    z
      .object({
        state: z.literal('unavailable'),
        enabled: z.boolean(),
        cause: z.enum([
          'authRequired',
          'nativeUnavailable',
          'ownerUnavailable',
          'custodyUnavailable',
        ]),
      })
      .strict(),
    z
      .object({
        state: z.literal('ready'),
        enabled: z.literal(true),
        workspaces: z
          .array(z.object({ workspaceId: ref, label: browserPlainText(512) }).strict())
          .max(64),
      })
      .strict(),
  ])
);
/** Canonical bounded current-tab snapshot, empty only for an actual original empty snapshot. */
export const BrowserProductionBindingsSchema = boundedBrowserJson(
  z.object({ bindings: z.array(BrowserBindingSchema).max(64) }).strict()
);
/** Human control request; body carries no owner/controller/grant manufacturing fields. */
export const BrowserProductionControlRequestSchema = boundedBrowserJson(
  z.object({ binding: BrowserBindingSchema }).strict()
);
/** Correlated original production acquisition projection. */
export type BrowserProductionOpenReceipt = z.infer<typeof BrowserProductionOpenReceiptSchema>;
/** Owner-qualified production mode status, never Page permission. */
export type BrowserProductionStatus = z.infer<typeof BrowserProductionStatusSchema>;

/** Explicit Settings opt-in; the boolean carries no native/actor authority. */
export const BrowserProductionEnableRequestSchema = boundedBrowserJson(
  z
    .object({ enabled: z.boolean(), chromeUserAgent: z.boolean().optional() })
    .strict()
    .refine((value) => value.chromeUserAgent === undefined || value.enabled === false, {
      message: 'Choose Chrome identity only while Shared browser is off.',
    })
);

/** Explicit owner/controller navigation request. Wire references never mint private permission. */
export const BrowserProductionNavigateRequestSchema = boundedBrowserJson(
  z
    .object({
      command: BrowserNavigateRequestSchema,
      controllerId: ref,
    })
    .strict()
);
/** Exact original request correlation and observed successor document binding. */
export const BrowserProductionNavigateReceiptSchema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      binding: BrowserBindingSchema,
    })
    .strict()
);
/** Metadata returned only after original authenticated navigation settlement. */
export type BrowserProductionNavigateReceipt = z.infer<
  typeof BrowserProductionNavigateReceiptSchema
>;

/** Owner-authenticated creation of named metadata only; no storage/path or actor DTO. */
export const BrowserProductionProfileCreateRequestSchema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      label: browserPlainText(512).refine((value) => value.trim().length > 0),
    })
    .strict()
);
export const BrowserProductionProfileCreateReceiptSchema = boundedBrowserJson(
  z.object({ requestId: ref, profile: BrowserProfileSchema }).strict()
);
/** Owner-authorized import always allocates a new named profile; no destination ID is accepted. */
export const BrowserProductionProfileImportRequestSchema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      label: browserPlainText(512).refine((value) => value.trim().length > 0),
      workspaceId: ref,
      storageState: BrowserStorageStateSchema,
    })
    .strict()
);
export const BrowserProductionProfileImportReceiptSchema =
  BrowserProductionProfileCreateReceiptSchema;
export type BrowserProductionProfileImportRequest = z.infer<
  typeof BrowserProductionProfileImportRequestSchema
>;
export type BrowserProductionProfileImportReceipt = z.infer<
  typeof BrowserProductionProfileImportReceiptSchema
>;
export type BrowserProductionProfileCreateRequest = z.infer<
  typeof BrowserProductionProfileCreateRequestSchema
>;
export type BrowserProductionProfileCreateReceipt = z.infer<
  typeof BrowserProductionProfileCreateReceiptSchema
>;

/** Explicit separate diagnostics grant; controller/view tickets cannot replace it. */
export const BrowserDiagnosticsRequestSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      grant: z.object({ grantId: ref, revision: counter }).strict(),
    })
    .strict()
);
export type BrowserDiagnosticsRequest = z.infer<typeof BrowserDiagnosticsRequestSchema>;

/** Exact staged ID and canonical click coordinates; independent upload/artifact/control grants remain required. */
export const BrowserUploadRequestSchema = boundedBrowserJson(
  z
    .object({
      kind: z.literal('upload'),
      requestId: ref,
      binding: BrowserBindingSchema,
      artifactId: ref,
      activation: z
        .object({
          x: z.number().finite().min(0).max(16384),
          y: z.number().finite().min(0).max(16384),
        })
        .strict(),
    })
    .strict()
);
export type BrowserUploadRequest = z.infer<typeof BrowserUploadRequestSchema>;

/** One explicitly admitted same-tab native response; activation alone never grants a download. */
export const BrowserDownloadRequestSchema = boundedBrowserJson(
  z
    .object({
      kind: z.literal('download'),
      requestId: ref,
      binding: BrowserBindingSchema,
      activation: z
        .object({
          x: z.number().finite().min(0).max(16384),
          y: z.number().finite().min(0).max(16384),
        })
        .strict(),
    })
    .strict()
);
export type BrowserDownloadRequest = z.infer<typeof BrowserDownloadRequestSchema>;

/** An owner explicitly approves one loopback HTTP endpoint for this browser, never an app endpoint. */
export const BrowserLocalDestinationRequestSchema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      binding: BrowserBindingSchema,
      endpoint: z
        .string()
        .max(512)
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              url.protocol === 'http:' &&
              ['127.0.0.1', '[::1]'].includes(url.hostname) &&
              !url.username &&
              !url.password &&
              url.pathname === '/' &&
              !url.search &&
              !url.hash
            );
          } catch {
            return false;
          }
        }),
      ttlMilliseconds: z.number().int().min(1).max(300000),
    })
    .strict()
);
export const BrowserLocalDestinationReceiptSchema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      binding: BrowserBindingSchema,
      endpoint: z.string().max(512),
      expiresAt: z.string().datetime(),
    })
    .strict()
);
export type BrowserLocalDestinationRequest = z.infer<typeof BrowserLocalDestinationRequestSchema>;
export type BrowserLocalDestinationReceipt = z.infer<typeof BrowserLocalDestinationReceiptSchema>;

/** Explicit self grant; identity/recipient are resolved by the server, never supplied by this DTO. */
export const BrowserHumanGrantRequestSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      attachment: BrowserAttachmentSchema,
      permissions: z
        .array(
          z.enum(['browser.diagnostics', 'browser.artifact', 'browser.upload', 'browser.download'])
        )
        .min(1)
        .max(4)
        .refine((values) => new Set(values).size === values.length),
      expiresInMs: z.number().int().min(1).max(300000),
    })
    .strict()
);
export const BrowserFileGrantReferenceSchema = z
  .object({ grantId: ref, revision: counter })
  .strict();
export const BrowserHumanGrantRevokeSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      grant: BrowserFileGrantReferenceSchema,
      permission: z.enum([
        'browser.diagnostics',
        'browser.artifact',
        'browser.upload',
        'browser.download',
      ]),
    })
    .strict()
);
/** Bounded base64 fits the original app's 1 MiB JSON body limit; native staging remains independently bounded. */
export const BrowserHumanStageRequestSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      artifactGrant: BrowserFileGrantReferenceSchema,
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u),
      mimeType: z.enum(['text/plain', 'application/pdf', 'image/png', 'image/jpeg']),
      base64: z
        .string()
        .min(4)
        .max(699052)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
    })
    .strict(),
  720000
);
export const BrowserHumanStageReceiptSchema = boundedBrowserJson(
  z.object({ artifactId: ref, byteLength: z.number().int().min(1).max(524288) }).strict()
);
const humanCommand = {
  binding: BrowserBindingSchema,
  controllerId: ref,
  artifactGrant: BrowserFileGrantReferenceSchema,
  transferGrant: BrowserFileGrantReferenceSchema,
  controlGrant: BrowserFileGrantReferenceSchema.optional(),
};
const sameFileBinding = (value: {
  binding: BrowserBinding;
  command: { binding: BrowserBinding };
}) =>
  Object.keys(value.binding).every(
    (key) =>
      value.binding[key as keyof BrowserBinding] ===
      value.command.binding[key as keyof BrowserBinding]
  );
export const BrowserHumanUploadRequestSchema = boundedBrowserJson(
  z
    .object({ ...humanCommand, command: BrowserUploadRequestSchema })
    .strict()
    .refine(sameFileBinding)
);
export const BrowserHumanDownloadRequestSchema = boundedBrowserJson(
  z
    .object({ ...humanCommand, command: BrowserDownloadRequestSchema })
    .strict()
    .refine(sameFileBinding)
);
export const BrowserHumanArtifactReadRequestSchema = boundedBrowserJson(
  z
    .object({
      binding: BrowserBindingSchema,
      artifactGrant: BrowserFileGrantReferenceSchema,
      artifactId: ref,
    })
    .strict()
);
export const BrowserHumanDownloadReceiptSchema = boundedBrowserJson(
  z
    .object({
      input: BrowserActionReceiptSchema,
      artifact: z
        .object({
          artifactId: ref,
          byteLength: z.number().int().min(1).max(2097152),
          name: z.string().max(128),
          mimeType: z.string().max(128),
        })
        .strict(),
    })
    .strict()
    .refine((value) => value.input.outcome === 'completed')
);
export const BrowserHumanArtifactReceiptSchema = boundedBrowserJson(
  z
    .object({
      artifactId: ref,
      byteLength: z.number().int().min(1).max(2097152),
      name: z.string().max(128),
      mimeType: z.string().max(128),
      base64: z
        .string()
        .min(4)
        .max(2796204)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
    })
    .strict(),
  2820000
);
export type BrowserHumanGrantRequest = z.infer<typeof BrowserHumanGrantRequestSchema>;
export type BrowserHumanGrantRevoke = z.infer<typeof BrowserHumanGrantRevokeSchema>;
export type BrowserHumanStageRequest = z.infer<typeof BrowserHumanStageRequestSchema>;
export type BrowserHumanStageReceipt = z.infer<typeof BrowserHumanStageReceiptSchema>;
export type BrowserHumanUploadRequest = z.infer<typeof BrowserHumanUploadRequestSchema>;
export type BrowserHumanDownloadRequest = z.infer<typeof BrowserHumanDownloadRequestSchema>;
export type BrowserHumanDownloadReceipt = z.infer<typeof BrowserHumanDownloadReceiptSchema>;
export type BrowserHumanArtifactReadRequest = z.infer<typeof BrowserHumanArtifactReadRequestSchema>;
export type BrowserHumanArtifactReceipt = z.infer<typeof BrowserHumanArtifactReceiptSchema>;
