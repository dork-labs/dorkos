import { z } from 'zod';
import {
  BrowserInstanceSchema,
  BrowserOpenRequestSchema,
  BrowserProductionInitialUrlSchema,
  type BrowserOpenRequest,
  BrowserBindingSchema,
  BrowserControlSchema,
  BrowserActionReceiptSchema,
  BrowserReferenceSchema,
  type BrowserBinding,
} from '@dorkos/shared/browser-schemas';
import {
  SemanticSnapshotV1Schema,
  SemanticReceiptV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import { defineCapability, type CapabilityDomain } from '../../core/capabilities/index.js';
import {
  ManagedBrowserGrantSchema,
  ManagedBrowserTabsSchema,
  ManagedBrowserControlSchema,
  ManagedBrowserInputSchema,
  ManagedBrowserNavigateSchema,
  ManagedBrowserSemanticActionSchema,
  ManagedBrowserStageSchema,
  ManagedBrowserUploadSchema,
  ManagedBrowserDownloadSchema,
  type createManagedBrowserRuntimeTools,
} from './runtime-tools.js';

export const ManagedBrowserDelegatedOpenSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    request: BrowserOpenRequestSchema.refine((value) => value.mode === 'ephemeral'),
    initialUrl: BrowserProductionInitialUrlSchema.optional(),
  })
  .strict();
export const ManagedBrowserFileApprovalSchema = z
  .object({
    binding: BrowserBindingSchema,
    sessionId: z.string().min(1).max(128),
    operation: z.enum(['upload', 'download']),
  })
  .strict();
/** Only an original live production graph can return this private receiver. */
export interface ManagedBrowserCapabilityDeps {
  current(): boolean;
  optionalAvailable(): boolean;
  describeFileApproval(input: z.output<typeof ManagedBrowserFileApprovalSchema>): string;
  issueFileApproval(
    context: CapabilityHandlerContext,
    input: z.output<typeof ManagedBrowserFileApprovalSchema>
  ): Promise<z.output<typeof ManagedBrowserGrantSchema>>;
  describeDelegation(input: z.output<typeof ManagedBrowserDelegatedOpenSchema>): string;
  openDelegated(
    context: CapabilityHandlerContext,
    input: z.output<typeof ManagedBrowserDelegatedOpenSchema>
  ): ReturnType<ManagedBrowserCapabilityDeps['open']>;
  close(
    context: CapabilityHandlerContext,
    binding: BrowserBinding
  ): Promise<z.output<typeof BrowserInstanceSchema>>;
  open(
    context: CapabilityHandlerContext,
    request: BrowserOpenRequest,
    initialUrl?: string
  ): Promise<
    Readonly<{
      instance: z.output<typeof BrowserInstanceSchema>;
      binding: BrowserBinding;
      grant: z.output<typeof ManagedBrowserGrantSchema>;
    }>
  >;
  resolve(binding: BrowserBinding): ReturnType<typeof createManagedBrowserRuntimeTools>;
}
declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    managedBrowserDeps?: ManagedBrowserCapabilityDeps;
  }
}
const areaNote =
  'A current authenticated runtime principal and exact explicit browser recipient grant are required inside every operation.';
/** Managed tools share the existing authenticated in-session projection for all runtimes. */
export const managedBrowserDomain: CapabilityDomain = {
  name: 'browser',
  assertDeps(deps) {
    if (!deps.managedBrowserDeps) throw new Error('Managed browser issuer is missing.');
  },
  available(deps) {
    return deps.managedBrowserDeps?.current() === true;
  },
  capabilities: [
    defineCapability({
      id: 'browser.file_access',
      title: 'Allow this agent to transfer a browser file',
      description:
        'Ask the signed-in owner to allow sending a file to this browser or saving a file from it for the current agent task.',
      tier: 'destructive',
      area: null,
      areaNote,
      input: ManagedBrowserFileApprovalSchema,
      output: ManagedBrowserGrantSchema,
      describeApprovalChange: async (deps, input) =>
        deps.managedBrowserDeps!.describeFileApproval(input),
      surfaces: {
        mcp: {
          toolName: 'managed_browser_file_access',
          servers: ['in-session'],
        },
      },
      invoke: (deps, input, context) => deps.managedBrowserDeps!.issueFileApproval(context, input),
    }),
    defineCapability({
      id: 'browser.open_delegated',
      title: 'Allow this agent to open a workspace browser',
      description:
        'Ask the signed-in owner to allow one independent ephemeral browser in this workspace for the exact current agent session. The workspace ownership stays unchanged.',
      tier: 'destructive',
      area: null,
      areaNote:
        'Only the actual owner decision for this exact workspace, path and current runtime session can issue the private delegation. Room membership never grants browser access.',
      input: ManagedBrowserDelegatedOpenSchema,
      output: z
        .object({
          instance: BrowserInstanceSchema,
          binding: BrowserBindingSchema,
          grant: ManagedBrowserGrantSchema,
        })
        .strict(),
      describeApprovalChange: async (deps, input) =>
        deps.managedBrowserDeps!.describeDelegation(input),
      surfaces: {
        mcp: {
          toolName: 'managed_browser_open_delegated',
          servers: ['in-session'],
        },
      },
      invoke: (deps, input, context) => deps.managedBrowserDeps!.openDelegated(context, input),
    }),
    defineCapability({
      id: 'browser.open',
      title: 'Open an independent managed browser',
      description:
        'Open a clean managed browser in this current agent turn’s own workspace. The server resolves the actual workspace and issues the scoped recipient grant after native acquisition.',
      tier: 'act',
      area: null,
      areaNote:
        'The genuine runtime owner, active durable author and exact agent-owned workspace are checked by the private birth issuer. Tool arguments cannot select an owner, recipient or workspace.',
      input: z
        .object({
          request: BrowserOpenRequestSchema.refine((value) => value.mode === 'ephemeral'),
          initialUrl: BrowserProductionInitialUrlSchema.optional(),
        })
        .strict(),
      output: z
        .object({
          instance: BrowserInstanceSchema,
          binding: BrowserBindingSchema,
          grant: ManagedBrowserGrantSchema,
        })
        .strict(),
      surfaces: {
        mcp: { toolName: 'managed_browser_open', servers: ['in-session'] },
      },
      invoke: (deps, request, context) =>
        deps.managedBrowserDeps!.open(context, request.request, request.initialUrl),
    }),

    defineCapability({
      id: 'browser.close',
      title: 'Close this turn’s managed browser',
      description:
        'Close and join an independent managed browser created for this exact current agent turn. A reference cannot close another turn’s or human-owned browser.',
      tier: 'act',
      area: null,
      areaNote,
      input: z.object({ binding: BrowserBindingSchema }).strict(),
      output: BrowserInstanceSchema,
      surfaces: {
        mcp: { toolName: 'managed_browser_close', servers: ['in-session'] },
      },
      invoke: (deps, request, context) => deps.managedBrowserDeps!.close(context, request.binding),
    }),
    defineCapability({
      id: 'browser.tabs',
      title: 'Read the granted browser tab',
      description:
        'Read the current canonical binding for an explicitly granted managed browser tab. References select a grant; they never create permission.',
      tier: 'observe',
      area: null,
      areaNote,
      input: ManagedBrowserTabsSchema,
      output: z.array(BrowserBindingSchema).max(1),
      surfaces: {
        mcp: { toolName: 'managed_browser_tabs', servers: ['in-session'] },
      },
      invoke: (deps, request, context) =>
        deps.managedBrowserDeps!.resolve(request.binding).tabs(context, request),
    }),
    defineCapability({
      id: 'browser.control',
      title: 'Take granted browser control',
      description:
        'Take control of the exact managed tab using a current explicit browser.control grant. This fences the old controller and returns the actual successor binding.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserControlSchema,
      output: BrowserControlSchema,
      surfaces: {
        mcp: { toolName: 'managed_browser_control', servers: ['in-session'] },
      },
      invoke: (deps, request, context) =>
        deps.managedBrowserDeps!.resolve(request.binding).control(context, request),
    }),
    defineCapability({
      id: 'browser.navigate',
      title: 'Navigate the granted browser tab',
      description:
        'Open a URL in the exact tab with explicit control permission. Old viewers and input are fenced before the native navigation; use the returned binding for fresh control.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserNavigateSchema,
      output: BrowserBindingSchema,
      surfaces: {
        mcp: { toolName: 'managed_browser_navigate', servers: ['in-session'] },
      },
      invoke: (deps, input, context) =>
        deps.managedBrowserDeps!.resolve(input.command.binding).navigate(context, input),
    }),
    defineCapability({
      id: 'browser.input',
      title: 'Send granted browser input',
      description:
        'Send one bounded canonical input command to the exact current managed tab/controller. An uncertain receipt may include side effects and must never be replayed automatically.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserInputSchema,
      output: BrowserActionReceiptSchema,
      surfaces: {
        mcp: { toolName: 'managed_browser_input', servers: ['in-session'] },
      },
      invoke: (deps, request, context) =>
        deps.managedBrowserDeps!.resolve(request.command.binding).input(context, request),
    }),
  ],
};

/** Optional tools expose only original actor hosts; listing never constructs a host or grant. */
export const managedBrowserOptionalDomain: CapabilityDomain = {
  name: 'browser',
  assertDeps(deps) {
    if (!deps.managedBrowserDeps) throw new Error('Managed browser issuer is missing.');
  },
  available(deps) {
    return (
      deps.managedBrowserDeps?.current() === true &&
      deps.managedBrowserDeps.optionalAvailable() === true
    );
  },
  capabilities: [
    defineCapability({
      id: 'browser.semantic_read',
      title: 'Read the granted page outline',
      description:
        'Read a bounded page outline using the current explicit browser.view grant. Private node references expire and do not grant permission to edit.',
      tier: 'observe',
      area: null,
      areaNote,
      input: ManagedBrowserTabsSchema,
      output: SemanticSnapshotV1Schema,
      surfaces: {
        mcp: {
          toolName: 'managed_browser_semantic_read',
          servers: ['in-session'],
        },
      },
      invoke: (deps, input, context) =>
        deps.managedBrowserDeps!.resolve(input.binding).semanticRead(context, input),
    }),
    defineCapability({
      id: 'browser.semantic_action',
      title: 'Act on a granted page element',
      description:
        'Use a fresh page element with explicit control permission. Secret edits require their separate permission and are never replayed automatically.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserSemanticActionSchema,
      output: SemanticReceiptV1Schema,
      surfaces: {
        mcp: {
          toolName: 'managed_browser_semantic_action',
          servers: ['in-session'],
        },
      },
      invoke: (deps, input, context) =>
        deps.managedBrowserDeps!.resolve(input.binding).semanticAction(context, input),
    }),
    defineCapability({
      id: 'browser.stage_upload',
      title: 'Stage a granted browser file',
      description:
        'Stage one bounded file with a separate artifact grant. Staging does not choose or submit a page file input.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserStageSchema,
      output: z
        .object({
          artifactId: BrowserReferenceSchema,
          byteLength: z.number().int().positive().max(2097152),
        })
        .strict(),
      surfaces: {
        mcp: {
          toolName: 'managed_browser_stage_upload',
          servers: ['in-session'],
        },
      },
      invoke: (deps, input, context) =>
        deps.managedBrowserDeps!.resolve(input.binding).stageUpload(context, input),
    }),
    defineCapability({
      id: 'browser.upload',
      title: 'Submit a granted browser file',
      description:
        'Submit a staged file to the exact current page chooser using separate file and control grants.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserUploadSchema,
      output: BrowserActionReceiptSchema,
      surfaces: {
        mcp: { toolName: 'managed_browser_upload', servers: ['in-session'] },
      },
      invoke: (deps, input, context) =>
        deps.managedBrowserDeps!.resolve(input.command.binding).upload(context, input),
    }),
    defineCapability({
      id: 'browser.download',
      title: 'Save a granted browser response',
      description:
        'Save the exact selected page response using separate file and control grants. Other page downloads remain blocked.',
      tier: 'act',
      area: null,
      areaNote,
      input: ManagedBrowserDownloadSchema,
      output: z
        .object({
          input: BrowserActionReceiptSchema,
          artifact: z
            .object({
              artifactId: BrowserReferenceSchema,
              byteLength: z.number().int().positive(),
              name: z.string().max(255),
              mimeType: z.string().max(255),
            })
            .strict(),
        })
        .strict(),
      surfaces: {
        mcp: { toolName: 'managed_browser_download', servers: ['in-session'] },
      },
      invoke: (deps, input, context) =>
        deps.managedBrowserDeps!.resolve(input.command.binding).download(context, input),
    }),
  ],
};
