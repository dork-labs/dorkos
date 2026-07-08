import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { TaskStore } from '../../../tasks/task-store.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import type { BindingStore } from '../../../relay/binding-store.js';
import type { BindingRouter } from '../../../relay/binding-router.js';
import type { TraceStore } from '../../../relay/trace-store.js';
import type { MeshCore } from '@dorkos/mesh';
import type { ExtensionManager } from '../../../extensions/extension-manager.js';

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
  /** Optional MeshCore — undefined when Mesh is disabled */
  meshCore?: MeshCore;
  /** Optional ExtensionManager — undefined when extensions are disabled */
  extensionManager?: ExtensionManager;
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
