/**
 * The agent tool kit: what every DorkOS agent tool is handed and how it answers
 * (spec `computer-side-starts-alone` §5.1).
 *
 * {@link AgentToolDeps} is the service bag the tool handlers read, built once at
 * boot; {@link jsonContent}, {@link structuredJsonContent} and
 * {@link requireTasks} shape their results. They lived in Claude Code's
 * `mcp-tools/types.ts`, which made every tasks, relay, mesh and extension tool
 * file import `runtimes/**` for a type and three helpers no runtime owns. Here
 * they are kernel: both sides may use them, and they hold no space data and no
 * turn.
 *
 * A port of the services import boundary (`eslint-rules/import-boundary.js`):
 * every domain may import it without making an edge, so it imports no other
 * domain except for types.
 *
 * @module services/core/agent-tool-kit/agent-tool-kit
 */
import type { TranscriptReader } from '../../runtimes/claude-code/sessions/transcript-reader.js';
import type { TaskStore } from '../../tasks/task-store.js';
import type { TaskRegistrar } from '../../tasks/task-registrar.js';
import type { TaskToolReach } from '../../tasks/agent-tools/task-tool-reach.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import type { BindingStore } from '../../relay/binding-store.js';
import type { BindingRouter } from '../../relay/binding-router.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { TraceStore } from '../../relay/trace-store.js';
import type { NotifyDmDeps } from '../../relay/notify-dm.js';
import type { MeshCore } from '@dorkos/mesh';
import type { ExtensionManager } from '../../extensions/extension-manager.js';
import type { RuntimeRegistry } from '../runtime-registry.js';
import type { ActivityService } from '../../activity/activity-service.js';
import type { ApprovalService } from '../approvals/index.js';
import type { CapabilityHandlerContext } from '../capabilities/registry.js';

/**
 * Who is proposing a schedule, read at CALL time rather than at registration.
 *
 * Both fields are resolved lazily and for the same reason: the SDK rekeys a
 * session to its canonical id mid-first-turn, so an id captured when the tool
 * server was built names a session that no longer exists. The DevTools tools
 * resolve their session id late for exactly this reason — see
 * `mcp-tools/index.ts`.
 *
 * Absent entirely on the sessionless external `/mcp` server, where there is no
 * session to attribute a proposal to and provenance stays null. Here, in the kit,
 * because the account and extension tools read the same caller (C9a).
 */
export type TaskProvenanceResolver = () => {
  /** The invoking session's canonical id. */
  sessionId?: string;
  /**
   * The invoking session's working directory, which is the key agent identity
   * is stored under (`agent-identity/agent-token-env.ts`) — so this is what
   * later resolves the proposer's name.
   */
  agentPath?: string;
  /** The folder the chat really runs in: its home, or a worktree mapped to it (DOR-3703). */
  cwd?: string;
  /** Every id the chat's turn levels may be kept under: its canonical one and its first. */
  turnSessionIds?: string[];
  /** The chat reads narrowed now: its turn runs where the status reads run unasked (DOR-4601). */
  narrowedReads?: boolean;
};

/** Announce that these extensions have a new bundle ready, by id. */
export type AnnounceExtensionsReloaded = (extensionIds: string[]) => void;

/**
 * The service bag every DorkOS agent tool handler reads.
 * All service dependencies are typed here and injected at server startup.
 */
export interface AgentToolDeps {
  transcriptReader: TranscriptReader;
  /** The default working directory for the server */
  defaultCwd: string;
  /**
   * The resolved DorkOS data directory (`lib/dork-home.ts`).
   *
   * Required, not optional, and for a reason worth stating: `tasks_create` writes
   * a SKILL.md into a skills root, and the global root is a path under this
   * directory. A tool that could not resolve it wrote the row alone and produced a
   * file-less orphan, which is exactly the bug DOR-1568 closed — so the create
   * cannot be built without knowing where files go.
   */
  dorkHome: string;
  /** Optional Task store — undefined when Tasks is disabled */
  taskStore?: TaskStore;
  /**
   * What the tasks tools reach in other domains, handed in so they import none
   * (`tasks/agent-tools/task-tool-reach.ts`). Without it the tasks tools refuse,
   * as they do with Tasks off.
   */
  tasksReach?: TaskToolReach;
  /**
   * The registration seam that keeps running cron jobs in step with task rows,
   * resolved LAZILY (DOR-1493).
   *
   * A getter rather than the registrar itself, because of boot order: these
   * deps are assembled in `index.ts` roughly a hundred lines before
   * `TaskRegistrar` exists, so a plain field would be captured as `undefined`
   * forever and the tools would go on writing rows that no scheduler ever
   * hears about — `tasks_update` leaving the old cron firing, `tasks_delete`
   * leaving a job firing against a row that is gone. Resolved at call time, it
   * is simply there by the time any tool runs.
   *
   * Undefined when Tasks is disabled, and null before the scheduler is built.
   */
  resolveTaskRegistrar?: () => TaskRegistrar | null;
  /**
   * When a task's live job fires next, or `null` when nothing will fire it —
   * the scheduler's own answer, read at call time for the same boot-order
   * reason as {@link AgentToolDeps.resolveTaskRegistrar}. `tasks_list` used to
   * hand agents the stored row's `nextRun: null` for every task, scheduled or
   * not (DOR-3125); `GET /api/tasks` already asked the scheduler.
   */
  nextRunOf?: (taskId: string) => Date | null;
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
   * The rooms THIS CALLER can see, for the two sidebar-section capabilities that
   * have to check a room reference before storing one (DOR-2055).
   *
   * ## Why it is scoped to the caller and not to the operator
   *
   * The first version asked the OWNER's view, on the reasoning that the sidebar
   * being edited is the person's and may legitimately hold rooms the calling
   * agent never joined. That reasoning is true and it was still the wrong
   * answer, because the verbs REPORT what they resolved: an agent could guess a
   * DM title, get back `notPresent: [{ roomId: <the real id> }]`, and learn that
   * the operator's private conversation exists. `room-visibility.ts` closes
   * exactly that oracle on purpose — "not visible" and "no such room" answer
   * identically, because a room id is never a capability — and a second seam
   * that answers a wider question reopens it.
   *
   * So this tool sees exactly what its caller sees. The owner still resolves
   * every room on the install (`seesEveryRoom`), so the person's own path is
   * unchanged; an agent resolves the rooms it is on the roster of and no others,
   * and a room it cannot see is refused with the same words a room that never
   * existed gets. The AGENT roster next door stays install-wide deliberately:
   * agents are not secret, and `mesh_list` already lists them all.
   *
   * ## Shape
   *
   * A function of the caller returning plain rows, rather than the rooms service
   * itself: the operator domain has no business holding `RoomService` to ask one
   * yes-or-no question, and the answer is per-call anyway — a room can be
   * archived, or an agent removed from it, between two turns of one
   * conversation. The visibility rule itself is NOT restated here; the
   * implementation is `rooms/visible-rooms-for-caller.ts`, which resolves the
   * caller through the rooms domain's own `callerAuthor` and lists through
   * `RoomService.listRooms`, so every grant those already encode carries over by
   * construction.
   *
   * **Calling this WRITES.** Resolving the caller upserts an author row —
   * `callerAuthor` goes through `resolveAgent` / `localHuman` / `bindOwner`, all
   * of which mint a row the first time this database sees a principal. It is the
   * same write every room verb already performs, so nothing new happens on any
   * path that has already run one; it is stated because a lookup that writes is
   * worth knowing about, and because it means this cannot be called against a
   * read-only database.
   *
   * `undefined` means this process cannot answer for this caller — rooms are not
   * wired, the caller presented an identity that could not be verified, or the
   * lookup failed some other way. The implementation's `catch` is TOTAL by
   * design: this feeds a "may I store a reference to that room" decision, so it
   * fails closed, and any failure becomes "cannot answer" rather than an empty
   * list that would read as "no such room". It is never "no rooms": a room
   * reference is then refused rather than stored unchecked. See `SidebarRoster`
   * in `core/operator/sidebar-item-refs.ts`.
   */
  listVisibleRooms?: (
    caller: CapabilityHandlerContext
  ) => { roomId: string; name: string; slug: string | null }[] | undefined;
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
   * Tells every open app that these extensions have a new bundle ready, so it
   * loads it. Boot passes `broadcastExtensionReloaded` (`routes/extensions.ts`);
   * absent in a test that does not watch it, and then a reload is not announced.
   */
  announceExtensionsReloaded?: AnnounceExtensionsReloaded;
  /**
   * Optional multi-runtime `RuntimeRegistry` singleton — powers the external
   * MCP server's `dorkos://sessions` resources (ADR-0310 fan-out, mirroring
   * `GET /api/sessions`). Always populated in production (the registry is
   * core infra, not a feature flag); optional here only so hermetic
   * `AgentToolDeps` test fixtures that don't exercise session resources don't
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

/** What a tasks tool answers when Tasks is off, or nothing was wired for it. */
export const TASKS_OFF_ERROR = 'Scheduled tasks are turned off on this DorkOS';

/**
 * Guard that returns an error response when Tasks is disabled, or the tasks
 * tools were handed nothing to reach, or `null` when the `tasks_*` handler may
 * proceed.
 *
 * @param deps - Shared MCP tool dependencies.
 */
export function requireTasks(deps: AgentToolDeps) {
  if (!deps.taskStore || !deps.tasksReach) {
    return jsonContent({ error: TASKS_OFF_ERROR }, true);
  }
  return null;
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
