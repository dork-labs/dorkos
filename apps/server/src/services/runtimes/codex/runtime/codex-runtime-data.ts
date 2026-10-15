import type { CodexThreadMap } from '../thread-map.js';
import type { CodexModelCatalog } from '../model-catalog.js';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';
import type { CodexTransportKind, CodexTransport } from '../transport/index.js';
import type { CreditsRelay } from '../../../core/cloud/credits-relay.js';
import type {
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import type { CodexNativeEntry } from './codex-native-custody.js';
import type { OpenConnectorTurnResult } from '../../../connectors/runtime-principal-port.js';

/** Constructor dependencies for {@link CodexRuntime} (composition root). */
export interface CodexRuntimeOptions {
  /** Durable sessionId ↔ threadId binding (backed by the `codex_threads` table). */
  threadMap: CodexThreadMap;
  /**
   * How this runtime finds its `codex` binary. Defaults to the shared ladder
   * ({@link resolveCodexBinaryPath}: configured `binaryPath` → SDK-vendored →
   * provisioned → `PATH`), which is the SAME resolution the dependency check
   * reports on, so the status card and the turn can never disagree. Injectable
   * for tests; production passes nothing.
   */
  resolveBinary?: () => Promise<string | null>;
  /** Account-aware model catalog; injectable so runtime tests never spawn app-server. */
  modelCatalog?: Pick<CodexModelCatalog, 'getSupportedModels'>;
  /**
   * Fallback working directory for a turn that arrives with no cwd from any
   * source (send opts, registry, persisted binding) — mirrors the Claude
   * adapter's default. Guarantees every bound thread persists a real cwd, so
   * a `codex_threads` row can never be minted cwd-less (DOR-202). Defaults to
   * the server's resolved workspace root.
   */
  defaultCwd?: string;
  /**
   * Where images this runtime's turns produce are stored (the local store over
   * the resolved data directory in production). Omitted, the runtime declares
   * `mediaOutput: 'none'` and says so per image rather than dropping one
   * quietly — see {@link CodexRuntime.getCapabilities}.
   */
  attachments?: SessionAttachmentStore;
  /**
   * How this runtime talks to Codex (`runtimes.codex.transport`, already
   * resolved — `resolveCodexTransport`), or a ready transport (tests). Fixed
   * for the runtime's life: capabilities are cached by clients, so a change
   * takes effect at the next server start. Required, so no caller can fall
   * back to a transport the product does not default to.
   */
  transport: CodexTransportKind | CodexTransport;
  /**
   * The loopback credits relay, when boot started one. Only the app-server
   * transport uses it: a credits thread's provider points at the relay, so the
   * credits token never enters Codex's process.
   */
  creditsRelay?: () => CreditsRelay | undefined;
}

/** Original prepared Room continuation DATA; only native custody readers prove its current authority. */
export type CodexPreparedRoomContinuation = {
  prepared: PreparedRoomResponder;
  committed: OriginalCommittedRoomResponder;
  controller: AbortController;
  nativeOperation: object;
  nativeEntry: CodexNativeEntry;
  binding: OpenConnectorTurnResult;
  retire: () => Promise<void>;
};

export {
  MAX_CONSECUTIVE_WAKES,
  WAKE_BUDGET_SPENT_COPY,
  wakeContextOf,
  sharedWakeContext,
  type CodexWakeContext,
} from '../app-server/background-wake.js';
