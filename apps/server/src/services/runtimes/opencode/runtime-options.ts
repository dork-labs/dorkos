import type { OpenCodeClientProvider, OpenCodeSessionMapStore } from './sessions/session-mapper.js';
import type { ConnectorRuntime } from '../../connectors/runtime-principal-port.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';

/** Constructor dependencies for the OpenCode runtime (composition root). */
export interface OpenCodeRuntimeOptions {
  /**
   * Sidecar client source — the `openCodeServerManager` singleton in
   * production, a mock in tests (the `opencode` binary is never required).
   */
  provider: OpenCodeClientProvider;
  /** Distinct instance identity; existing host runtime remains opencode. */
  runtimeId?: ConnectorRuntime;
  /** Instance-local inference choice; defaults to the host choice. */
  runsOnCredits?: () => boolean;
  /** Directory used for model discovery; defaults to the host default. */
  modelDirectory?: string;
  /**
   * Durable sessionId <-> OpenCode-session-id store (`OpenCodeSessionMap`
   * over the shared Drizzle handle in production). Keeps DorkOS-facing ids
   * stable across server restarts (DOR-251); tests that don't exercise
   * persistence may omit it.
   */
  sessionMap?: OpenCodeSessionMapStore;
  /**
   * Where images this runtime's turns produce are stored (the local store over
   * the resolved data directory in production). Omitted, the runtime declares
   * `mediaOutput: 'none'` and says so per image rather than dropping one
   * quietly — see {@link OpenCodeRuntime.getCapabilities}.
   */
  attachments?: SessionAttachmentStore;
}
