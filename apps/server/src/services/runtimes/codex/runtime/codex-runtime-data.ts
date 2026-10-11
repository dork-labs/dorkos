import type { MessageOpts } from '@dorkos/shared/agent-runtime';
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
import type { BackgroundCompletion } from '../app-server/background-work.js';

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

/**
 * Model turns background work may start in a row with no dispatched turn
 * between them. Each wake is the agent answering its own work; three in a row
 * with nobody's word in between is a loop, not progress, so the fourth
 * finish is shown and the chat waits for a person (spec §12).
 */
export const MAX_CONSECUTIVE_WAKES = 3;

/** What the person reads when the wake budget is spent. */
export const WAKE_BUDGET_SPENT_COPY =
  'Codex woke this chat three times in a row, so it waits for you now.';

/** The options a wake's turn inherits from the turn that left the work running. */
export interface CodexWakeContext {
  readonly opts: MessageOpts;
}

/**
 * The part of a dispatched turn's options a wake's turn may carry: who it runs
 * as, where, with which folders and account. Never the message's own id,
 * title, disposition or attached context, which belong to that message.
 *
 * **Never the permission mode, model, effort or fast mode.** Those are the
 * session's, and the person may change them after the starting turn: a
 * scheduled run at Full access must not make a wake run at Full access after
 * the person set Ask first. The wake reads the session's current values.
 *
 * A room turn returns `undefined`: its tools and identity are bound to the
 * room's dispatch (its turn id and author), which a wake cannot reproduce, so
 * its leftover work is shown and the room carries on on its own next turn —
 * which also keeps every wake inside the room's own turn limits.
 */
export function wakeContextOf(
  opts: MessageOpts | undefined,
  cwd: string
): CodexWakeContext | undefined {
  if (opts?.roomTurn !== undefined) return undefined;
  const carried = {
    cwd,
    ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}),
    ...(opts?.systemPromptAppend !== undefined
      ? { systemPromptAppend: opts.systemPromptAppend }
      : {}),
    ...(opts?.additionalDirectories !== undefined
      ? { additionalDirectories: opts.additionalDirectories }
      : {}),
    ...(opts?.accountHint !== undefined ? { accountHint: opts.accountHint } : {}),
    ...(opts?.unattended !== undefined ? { unattended: opts.unattended } : {}),
    ...(opts?.unattendedApprovals !== undefined
      ? { unattendedApprovals: opts.unattendedApprovals }
      : {}),
    // The bound travels with the work it bounds: a wake turn after background
    // work an outsider's turn started runs no looser than that turn did.
    ...(opts?.permissionCeiling !== undefined ? { permissionCeiling: opts.permissionCeiling } : {}),
  } as MessageOpts;
  return { opts: carried };
}

/**
 * The one context every waking completion shares, or `undefined` when any
 * lacks one or they came from turns run differently: then the finishes are
 * shown and no model turn starts, rather than one running as the wrong agent.
 */
export function sharedWakeContext(
  completions: readonly BackgroundCompletion[]
): CodexWakeContext | undefined {
  const contexts = completions.map(
    (completion) => completion.context as CodexWakeContext | undefined
  );
  const first = contexts[0];
  if (first === undefined) return undefined;
  const key = JSON.stringify(first.opts);
  return contexts.every((context) => context !== undefined && JSON.stringify(context.opts) === key)
    ? first
    : undefined;
}
