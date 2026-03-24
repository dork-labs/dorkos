import type { TranscriptReader } from '../transcript-reader.js';
import type { PulseStore } from '../../../pulse/pulse-store.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import type { BindingStore } from '../../../relay/binding-store.js';
import type { BindingRouter } from '../../../relay/binding-router.js';
import type { TraceStore } from '../../../relay/trace-store.js';
import type { MeshCore } from '@dorkos/mesh';

/**
 * Explicit dependency interface for MCP tool handlers.
 * All service dependencies are typed here and injected at server startup.
 */
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  /** The default working directory for the server */
  defaultCwd: string;
  /** Optional Pulse store — undefined when Pulse is disabled */
  pulseStore?: PulseStore;
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
}

/** Helper to return a JSON content block for MCP tool responses. */
export function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}
