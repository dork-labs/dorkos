import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { TaskStore } from '../../../tasks/task-store.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import type { BindingStore } from '../../../relay/binding-store.js';
import type { BindingRouter } from '../../../relay/binding-router.js';
import type { BridgeStore } from '../../../relay/chat-bridge/bridge-store.js';
import type { TraceStore } from '../../../relay/trace-store.js';
import type { NotifyDmDeps } from '../../../relay/notify-dm.js';
import type { MeshCore } from '@dorkos/mesh';
import type { ExtensionManager } from '../../../extensions/extension-manager.js';
import type { RuntimeRegistry } from '../../../core/runtime-registry.js';
import type { ActivityService } from '../../../activity/activity-service.js';
import type { ApprovalService } from '../../../core/approvals/index.js';

/**
 * Explicit dependency interface for MCP tool handlers.
 * All service dependencies are typed here and injected at server startup.
 */
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  /** The default working directory for the server */
  defaultCwd: string;
  /** Optional Task store — undefined when Tasks is disabled */
  taskStore?: TaskStore;
  /** Optional RelayCore — undefined when Relay is disabled */
  relayCore?: RelayCore;
  /** Optional AdapterManager — undefined when Relay adapters are not configured */
  adapterManager?: AdapterManager;
  /** Optional TraceStore — undefined when Relay tracing is disabled */
  traceStore?: TraceStore;
  /** Optional BindingStore — undefined when Relay bindings are not configured */
  bindingStore?: BindingStore;
  /** Optional BindingRouter for session map queries. */
  bindingRouter?: BindingRouter;
  /**
   * Optional BridgeStore — live bridge rows so `relay_notify_user` still
   * resolves a bridged chat once its session vacates `sessionMap`
   * (chats-as-channels spec §7.5). Undefined when Rooms/bridging is not wired.
   */
  bridgeStore?: BridgeStore;
  /** Optional MeshCore — undefined when Mesh is disabled */
  meshCore?: MeshCore;
  /**
   * Optional rooms seam for the first-party fallback `relay_notify_user` takes
   * when no external chat integration can carry a proactive message: the
   * caller's own direct message with the operator (DOR-1209). Undefined when
   * rooms or mesh are not wired — the tool then reports non-delivery exactly as
   * it did before, rather than pretending.
   */
  notifyDm?: NotifyDmDeps;
  /** Optional ExtensionManager — undefined when extensions are disabled */
  extensionManager?: ExtensionManager;
  /**
   * Optional multi-runtime `RuntimeRegistry` singleton — powers the external
   * MCP server's `dorkos://sessions` resources (ADR-0310 fan-out, mirroring
   * `GET /api/sessions`). Always populated in production (the registry is
   * core infra, not a feature flag); optional here only so hermetic
   * `McpToolDeps` test fixtures that don't exercise session resources don't
   * need to stub it.
   */
  runtimeRegistry?: RuntimeRegistry;
  /**
   * Optional {@link ActivityService} — powers the `activity_list` MCP tool
   * (the same append-only feed `GET /api/activity` reads). Always populated in
   * production (the service is core infra, constructed at boot); optional here
   * so hermetic tool-deps fixtures that don't exercise activity need not stub it.
   */
  activityService?: ActivityService;
  /**
   * Optional {@link ApprovalService} — the approval primitive the in-session hold
   * (DOR-939) waits on, so a fresh destructive capability call can hold inline
   * and resume on the operator's decision instead of returning a poll payload.
   * Always populated in production (constructed at boot beside the tier gate);
   * optional here so hermetic fixtures and the external `/mcp` surface — which is
   * sessionless and never holds — need not stub it.
   */
  approvals?: ApprovalService;
}

/** Helper to return a JSON content block for MCP tool responses. */
export function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Helper for the subset of tools that also declare an `outputSchema` on the
 * external MCP server (`services/core/mcp-server.ts`). Mirrors `data` into
 * `structuredContent` alongside the usual JSON text block — the MCP SDK
 * requires `structuredContent` on every non-error result once a tool has an
 * `outputSchema`, so success paths for those tools must return this instead
 * of {@link jsonContent}. Only use on success paths: error responses skip
 * output validation entirely, so keep using `jsonContent(..., true)` there.
 */
export function structuredJsonContent<T extends object>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as unknown as Record<string, unknown>,
  };
}
