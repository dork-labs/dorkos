/**
 * Universal AgentRuntime interface — the contract that all agent backends must implement.
 *
 * This module defines the abstraction layer between DorkOS routes/services and
 * specific agent backend implementations (ClaudeCodeRuntime, future OpenCodeRuntime, etc.).
 *
 * @module shared/agent-runtime
 */
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  SubagentInfo,
  CommandRegistry,
  PermissionMode,
  EffortLevel,
  ReloadPluginsResult,
  SessionSettings,
  SessionListWarning,
  MessageDisposition,
} from './types.js';
import type { AdditionalContext, ContextKind } from './additional-context.js';
import type { SessionSnapshot, SessionEvent, SessionListEvent } from './session-stream.js';
import type { RuntimeCommandIntentId } from './command-intents.js';

/**
 * The message-delivery vocabulary of the runtime contract, re-exported here so
 * an adapter reads its whole contract from one module.
 *
 * Defined once as Zod in `schemas.js` — they are wire types as well as contract
 * types (they ride the `queue_update` event and the message routes), and a
 * second hand-written copy of a union is exactly how the two drift apart.
 */
export type {
  MessageDisposition,
  DispositionDowngradeReason,
  MessageDeliveryOutcome,
  QueuedMessage,
} from './types.js';

/**
 * Where a permission mode sits on the one question the permission surface asks:
 * *when should this agent stop and check with me?*
 *
 * Three positions, fixed across every runtime — a runtime never invents a
 * fourth and never renames one, because the words are the person's mental
 * model, not the backend's vocabulary (spec `trust-dial`, decision 2).
 *
 * - `'ask'` — stop before doing anything that changes the world.
 * - `'act'` — get on with the work, stop for the risky parts.
 * - `'autonomy'` — never stop.
 */
export type PermissionStop = 'ask' | 'act' | 'autonomy';

/**
 * How often a mode actually stops to ask the person. Declared by the runtime
 * from its OWN behavior, which is why it is separate from {@link PermissionStop}:
 * where the two disagree the surface says so out loud (Codex's workspace-write
 * sits at `'act'` but asks `'never'`, because Codex has no way to pause).
 */
export type PermissionAsks = 'always' | 'when-risky' | 'never';

/**
 * The blast radius a person agrees to when they pick a mode — how far its
 * actions can reach, whether or not it asks first. Ordered least to most:
 *
 * - `'read'` — reads and answers only. **Nothing leaves and nothing changes**:
 *   no writes, no commands, and no network. Codex's `read-only` sandbox is the
 *   reference — it blocks network access as well as writes, and that is what
 *   makes it safe for the derivation rules to treat `'read'` as "there is
 *   nothing here to warn about or to ask permission for". A runtime whose
 *   read-ish mode can still fetch a URL or phone home must declare `'edit'` or
 *   wider, or it will be described as harmless when it is not.
 * - `'edit'` — files in the project may change; commands still go through the
 *   mode's asking rule.
 * - `'workspace'` — files *and* commands, inside the project directory.
 * - `'everything'` — no sandbox: anywhere on the machine, plus the network.
 */
export type PermissionReach = 'read' | 'edit' | 'workspace' | 'everything';

/**
 * Which question a mode answers.
 *
 * - `'trust'` — how much the agent may do without asking. These are the modes
 *   the Trust Dial's three stops select between.
 * - `'working'` — how the agent goes about the work, whatever the trust level.
 *   Claude's `plan` is the only one today: it reads and proposes, and nothing
 *   happens until the person approves the plan. It is a thing you switch on for
 *   a while, not a level you leave a session sitting at, so it is offered beside
 *   the composer instead of on the dial (spec `trust-dial`, decision 1).
 */
export type PermissionAxis = 'trust' | 'working';

/**
 * Describes a single permission mode a runtime supports. Runtimes enumerate
 * these so the UI can render a picker without hard-coding a shared enum.
 *
 * ## Why the semantics are here and not in the client
 *
 * Every surface that warns about a permission mode used to do it from an
 * id-keyed table in the client — one table for "is this a bypass mode", another
 * for "tint this red" — which meant a new runtime got the wrong warning until
 * somebody remembered to edit a file two packages away. The runtime is the only
 * thing that knows what its own modes do, so it says so here, in fields the
 * client can compute from by uniform rules and never by name (spec `trust-dial`,
 * decision 2; the Final Design Summary's implementation invariants).
 *
 * `stop`/`asks`/`reach`/`promise` are REQUIRED on purpose. A descriptor that
 * declares half its meaning is exactly the drift these fields exist to end.
 *
 * @see {@link RuntimeCapabilities.permissionModes}
 */
export interface PermissionModeDescriptor {
  /** Stable runtime-specific identifier (e.g. `'default'`, `'plan'`). */
  id: string;
  /** Human-readable label for dropdowns and picker UI. */
  label: string;
  /** Optional helper copy rendered beneath the label in rich pickers. */
  description?: string;
  /**
   * Which of the three dial positions this mode belongs to. Drives which stop
   * renders as selected, and — compared against {@link asks} — whether this
   * runtime diverges from the position's canonical promise.
   */
  stop: PermissionStop;
  /**
   * One plain sentence about what happens under this mode, in the person's
   * words. Rendered verbatim as the caption beneath the dial, so it is product
   * copy: describe the consequence, never the mechanism, and say the awkward
   * part out loud when the runtime's behavior is surprising.
   */
  promise: string;
  /**
   * How often this mode stops to ask. Drives the divergence signal (declared
   * `asks` vs. the canonical expectation of its {@link stop}) and, with
   * {@link reach}, the warning tier.
   */
  asks: PermissionAsks;
  /**
   * How far this mode's actions can reach. With {@link asks}, decides the
   * warning tier: never-asking plus everything-reaching is the one combination
   * that earns red.
   */
  reach: PermissionReach;
  /**
   * Which question this mode answers — a level of trust, or a way of working.
   *
   * Optional, and absent means `'trust'`: nearly every mode is a trust level,
   * and a runtime that says nothing gets the common answer rather than
   * disappearing from the dial. Declare `'working'` only for a mode that is not
   * a point on the trust axis at all, or the dial will offer two modes at one
   * stop and pick between them by declaration order.
   */
  axis?: PermissionAxis;
  /**
   * The runtime's own name for this mode, when it differs from {@link id} —
   * e.g. Codex's `'workspace-write'`. Detail views show it so somebody reading
   * the runtime's own docs can line the two up. Omit when the id is the native
   * name.
   */
  native?: string;
}

/** Minimal response interface for session locking — only needs close event detection. */
export interface SseResponse {
  on(event: 'close', cb: () => void): void;
}

/**
 * Runtime-neutral MCP server connection details, resolved by a runtime and
 * consumed by the DorkOS server to open its own short-lived MCP client for
 * reading MCP App (`ui://`) resources (ADR `260708-141143`). Deliberately
 * SDK-agnostic — mirrors the stdio/http/sse shapes without importing any
 * runtime SDK. **Server-only**: stdio `command`/`env` must never reach the
 * browser client, so this type is not part of any client-facing DTO.
 */
export type McpAppServerConnection =
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  | { transport: 'sse'; url: string; headers?: Record<string, string> };

/**
 * Narrow port interface for agent registry operations.
 * MeshCore satisfies this structurally — no `implements` clause needed.
 */
export interface AgentRegistryPort {
  /**
   * The agent registered at a working directory, or `undefined` when none is.
   *
   * **`name` and `displayName` are different strings and are not
   * interchangeable.** `name` is the slug — the address somebody types after an
   * `@` — and `displayName` is what a person reads (`docs-writer` against
   * `Docs Writer`). A caller that is labelling, rendering or attributing asks
   * for `displayName ?? name`; the slug alone belongs only where an address is
   * wanted. The port carried no display name at all until DOR-1264, which is
   * why both runtimes minted identity tokens under the slug and every room
   * message an agent wrote through a tool renamed it to one.
   */
  getByPath(cwd: string): { id: string; name?: string; displayName?: string } | undefined;
  updateLastSeen(agentId: string, event: string): void;
  /**
   * Every registered agent with its directory.
   *
   * `name` and `displayName` mean here exactly what they mean on
   * {@link AgentRegistryPort.getByPath}, and the same rule applies: render
   * `displayName ?? name`, and reach for the bare slug only when an address is
   * what is wanted. `displayName` is optional because an agent whose manifest
   * declares none genuinely has only a slug.
   */
  listWithPaths(): Array<{
    id: string;
    name: string;
    displayName?: string;
    projectPath: string;
    icon?: string;
    color?: string;
  }>;
}

/**
 * Narrow port interface for relay messaging operations.
 * RelayCore satisfies this structurally — no `implements` clause needed.
 */
export interface RelayPort {
  publish(subject: string, payload: unknown, options: unknown): Promise<unknown>;
}

/**
 * Narrow port for resolving an agent's enabled managed MCP servers for a
 * session's working directory. The server-side `AgentMcpServerService`
 * satisfies this structurally — a runtime depends on this minimal shape rather
 * than the whole service so it stays SDK- and DB-agnostic and trivially
 * testable. Returns the runtime-neutral {@link McpAppServerConnection} map keyed
 * by server name, or `{}` when the cwd hosts no readable agent manifest.
 * Mirrors {@link AgentRegistryPort}/{@link RelayPort}.
 */
export interface ManagedMcpServerResolver {
  /** Enabled managed servers for a session cwd, by name; `{}` when none apply. */
  injectableServersForCwd(cwd: string): Record<string, McpAppServerConnection>;
}

/**
 * Narrow port for durable per-session settings. The API core layer implements
 * this (over the `session_metadata` table) and injects it into runtimes via
 * {@link AgentRuntime.setSessionSettings}; runtimes never touch the DB directly.
 * Mirrors {@link AgentRegistryPort}/{@link RelayPort}. See ADR-0260.
 */
export interface SessionSettingsPort {
  /** Read a session's persisted settings, or null when no row exists. */
  getSessionSettings(sessionId: string): Promise<SessionSettings | null>;
  /**
   * Persist (UPSERT) the provided settings fields for a session.
   *
   * Settings only: this write stores what the person chose and asserts nothing
   * about the session itself. A session whose first message has not been sent
   * has no runtime yet, and a settings change is not what decides one — the
   * first turn is (ADR-0255, DOR-812).
   */
  saveSessionSettings(sessionId: string, settings: SessionSettings): Promise<void>;
  /**
   * Move a session's stored settings to a new id, so they stay under exactly
   * one key. A runtime calls this the moment it rebinds a session to a new
   * canonical id (claude-code does, on the first turn of a new session): every
   * write up to that instant went to `fromId`, and every read from now on will
   * ask by `toId`. Leaving the row behind would make the enforced permission
   * mode revert to the runtime default after eviction or a restart.
   *
   * Idempotent: a no-op when the ids match or `fromId` has no row.
   *
   * @param fromId - The id the settings are stored under today
   * @param toId - The canonical id the session is now known by
   */
  rekeySessionSettings(fromId: string, toId: string): Promise<void>;
}

/** Result of a single dependency check performed by a runtime adapter. */
export interface DependencyCheck {
  /** Human-readable dependency name (e.g. "Claude Code CLI"). */
  name: string;
  /** What this dependency is for. */
  description: string;
  /** Current status. */
  status: 'satisfied' | 'missing' | 'outdated';
  /** Installed version, if detected. */
  version?: string;
  /** Minimum required version, if applicable. */
  requiredVersion?: string;
  /** Shell command or instructions to install. */
  installHint?: string;
  /** URL for more information. */
  infoUrl?: string;
}

/**
 * The single call-to-action a not-ready runtime presents on the Connect path.
 *
 * A runtime is either **Ready** or offers exactly one **Connect** action —
 * never a raw dependency error (the binary/CLI detail lives behind an Advanced
 * disclosure). See spec `effortless-runtime-switching` (T0 Ready/Connect model).
 */
export interface RuntimeConnectAction {
  /**
   * What connecting means for this runtime:
   * - `install` — the runtime binary is missing and must be provisioned.
   * - `login` — the binary is present but no credential/login is configured.
   * - `provider-picker` — provider-agnostic auth (OpenCode) where connecting is
   *   "choose where the model comes from" (Local / Gateway / Direct). A coarse
   *   default for T0; T1 enriches the picker.
   */
  kind: 'install' | 'login' | 'provider-picker';
  /** Human-readable CTA label (e.g. "Install OpenCode"). Never a raw error string. */
  label: string;
}

/** Derived two-state readiness for one runtime (ADR-0316/0318 Ready/Connect model). */
export interface RuntimeReadiness {
  /**
   * `ready` when the binary resolves AND auth is satisfied (or not required,
   * e.g. Claude's delegated host login or a detected local model); otherwise
   * `connect`.
   */
  state: 'ready' | 'connect';
  /** The single Connect action to present; absent when `state` is `ready`. */
  connect?: RuntimeConnectAction;
}

/**
 * Per-runtime requirements entry: the raw checks plus the derived Ready/Connect
 * projection. `state`/`connect` are optional on the type only for backward-compat
 * during the T0 client rollout (setup fixtures predate the projection); the
 * server and DirectTransport always populate `state`.
 */
export interface RuntimeRequirements extends Partial<RuntimeReadiness> {
  /** Raw dependency results — consumed by the client's Advanced disclosure. */
  dependencies: DependencyCheck[];
  /**
   * For a runtime whose auth is provider-agnostic (OpenCode), the id of the
   * currently connected provider — e.g. `'ollama'`, `'openrouter'`, `'openai'` —
   * when one is persisted in DorkOS. Lets the client label a "Change power
   * source" affordance with the current source ("Currently: On your computer
   * (Ollama)"). Absent for runtimes with no provider concept, and for a runtime
   * connected outside DorkOS (e.g. the OpenCode CLI logged in directly).
   */
  provider?: string;
}

/**
 * Aggregated system requirements report for all registered runtimes.
 *
 * There is deliberately no cross-runtime "all satisfied" flag: readiness is
 * per-runtime (each entry's {@link RuntimeReadiness}), and consumers gate on
 * "at least one runtime ready" rather than "every runtime ready" — one working
 * agent is enough to start.
 */
export interface SystemRequirements {
  /** Per-runtime dependency results + Ready/Connect projection, keyed by runtime type. */
  runtimes: Record<string, RuntimeRequirements>;
}

/** Human-facing display names for the known runtime types (identity is honest, never a raw type slug). */
const RUNTIME_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * Human display name for a runtime type, falling back to the raw type when
 * unknown so a future runtime still renders (honestly, if plainly).
 *
 * @param type - Runtime type identifier (e.g. `'opencode'`).
 */
export function runtimeDisplayName(type: string): string {
  return RUNTIME_DISPLAY_NAMES[type] ?? type;
}

/**
 * The connect flow a runtime uses to (re)authenticate, independent of its
 * current readiness.
 *
 * A ready runtime reports no `connect` action, but "Ready" is only a fingerprint
 * check — it cannot see a stale or invalid credential — so the setup surface
 * still needs to know which flow to reopen when a user wants to fix their
 * sign-in. OpenCode is provider-agnostic (reconnecting means re-picking where
 * the model comes from), so it uses the provider picker; every other runtime
 * signs in.
 *
 * @param type - Runtime type identifier (e.g. `'claude-code'`).
 */
export function runtimeAuthConnectKind(type: string): 'login' | 'provider-picker' {
  return type === 'opencode' ? 'provider-picker' : 'login';
}

/**
 * Project a runtime's raw {@link DependencyCheck}[] into the two-state
 * Ready/Connect model surfaced by `GET /api/system/requirements`.
 *
 * A runtime is **Ready** iff its binary/CLI check is `satisfied` AND its auth
 * check is `satisfied` OR the runtime declares no auth check (Claude delegates
 * to host login, so "no auth check" reads as "auth not required"). Otherwise it
 * is **Connect** with a single action derived from what is blocking:
 * - missing binary → `install`
 * - satisfied binary + missing auth → `login` (or, for OpenCode's
 *   provider-agnostic auth, `provider-picker`)
 *
 * Pure and runtime-agnostic so the HTTP route and the in-process
 * DirectTransport project identically.
 *
 * @param type - Runtime type identifier (drives the label and the OpenCode
 *   provider-picker special case).
 * @param dependencies - The runtime's dependency-check results.
 */
export function deriveRuntimeReadiness(
  type: string,
  dependencies: DependencyCheck[]
): RuntimeReadiness {
  // The binary/CLI probe is the check whose name reads as a CLI (all three
  // runtimes name it "… CLI"); fall back to the first check defensively.
  const binaryCheck = dependencies.find((d) => /\bCLI\b/i.test(d.name)) ?? dependencies[0];
  // Auth is any OTHER check that reads as an authentication/login probe.
  const authCheck = dependencies.find((d) => d !== binaryCheck && /auth|login/i.test(d.name));

  const binaryReady = binaryCheck?.status === 'satisfied';
  // No auth check means the runtime needs no separate credential (auth not
  // required), so treat auth as satisfied.
  const authReady = authCheck ? authCheck.status === 'satisfied' : true;

  if (binaryReady && authReady) return { state: 'ready' };

  const name = runtimeDisplayName(type);
  if (!binaryReady) {
    return { state: 'connect', connect: { kind: 'install', label: `Install ${name}` } };
  }
  // Binary present, auth missing. OpenCode has no single "login" — connecting
  // means picking where the model comes from.
  if (runtimeAuthConnectKind(type) === 'provider-picker') {
    return {
      state: 'connect',
      connect: { kind: 'provider-picker', label: 'Choose a model provider' },
    };
  }
  return { state: 'connect', connect: { kind: 'login', label: `Connect ${name}` } };
}

/**
 * Per-runtime support for a single runtime-fulfilled command intent
 * (see {@link RuntimeCapabilities.commandIntents}).
 */
export interface CommandIntentSupport {
  /** Whether the runtime can fulfill this intent for a session. */
  supported: boolean;
}

/** One bespoke settings section a runtime's settings card renders. */
export interface RuntimeSettingsSection {
  /**
   * Renderer key, e.g. 'claude-accounts', 'opencode-power-source'. The client
   * maps known kinds to feature-supplied renderers (same slot pattern as the
   * connect flows); unknown kinds render nothing (forward-compatible).
   */
  kind: string;
}

/** Static settings declaration for a runtime. */
export interface RuntimeSettingsCapability {
  /**
   * Key of this runtime's section under `runtimes.*` in user config
   * ('claudeCode' | 'codex' | 'opencode' today), or null when the runtime has
   * no config section (test-mode). The runtime's own declaration is the single
   * source of this mapping, which used to be hand-kept on both the server and
   * the client. Typed `string | null` in shared (the config schema is
   * host-side); the server validates it against the real config shape with a
   * type guard and skips unknown sections.
   */
  configSection: string | null;
  /**
   * Whether this runtime takes an effort setting at all - the runtime-level
   * static fact, declared by the runtime itself rather than kept in a list
   * somewhere else. Per-model effort support remains
   * `ModelOption.supportsEffort` / `supportedEffortLevels`; both gates apply,
   * exactly as the runtime card's Effort row implements today.
   */
  supportsEffort: boolean;
  /** Ordered bespoke sections for the settings card. Empty for most runtimes. */
  sections: RuntimeSettingsSection[];
}

/**
 * Runtime capability flags — describes what a given backend supports.
 *
 * Genuinely-boolean capabilities remain flat booleans. Permission modes are
 * structured because different runtimes expose materially different sets
 * (see research 20260315_agent_runtime_permission_modes). The `features` map
 * is a typed extension point for runtime-specific metadata that does not
 * merit promotion to a first-class field; see ADR 0256.
 */
export interface RuntimeCapabilities {
  /** Runtime identifier, e.g. 'claude-code' | 'opencode' | 'aider' */
  readonly type: string;

  /** Whether tool approval UI should be shown */
  supportsToolApproval: boolean;

  /** Whether cost/token tracking is available */
  supportsCostTracking: boolean;

  /** Whether sessions can be resumed */
  supportsResume: boolean;

  /** Whether MCP tool servers can be injected */
  supportsMcp: boolean;

  /**
   * Whether DorkOS can inject an agent's own managed MCP servers (the
   * `mcp.*` management verbs, spec `mcp-server-management`) into its sessions.
   *
   * Distinct from {@link supportsMcp}, which specifically means the in-process
   * DorkOS tool server. A runtime can accept external managed servers without
   * hosting the DorkOS tool server (Codex, DOR-892) or vice versa. Gates the
   * client's "Add server" affordance on an agent's Tools & MCP page.
   */
  supportsManagedMcpServers: boolean;

  /** Whether AskUserQuestion interactive flow is supported */
  supportsQuestionPrompt: boolean;

  /**
   * Whether this runtime can load plugins. Gates the Claude-specific
   * `ClaudePluginTransport` shaping on the client transport.
   */
  supportsPlugins: boolean;

  /**
   * Structured permission-mode capability. `supported: false, values: []`
   * means the runtime does not expose a permission-mode picker at all.
   */
  permissionModes: {
    supported: boolean;
    /**
     * Mode id a supported runtime uses when a session has no stored preference
     * (NULL in the store). Runtimes that support modes should declare it; the
     * consumer falls back to its own default if omitted.
     */
    default?: string;
    values: PermissionModeDescriptor[];
  };

  /**
   * Support for RUNTIME-fulfilled command intents (currently `compact`).
   * Client-native intents (`clear`, `context`) are universal and not gated
   * here. `supported: false` → the palette disables the entry ("Not supported
   * by {runtime}") and the composer refuses to send the intent as text. A
   * first-class sibling of {@link RuntimeCapabilities.permissionModes} per
   * ADR-0256, not the `features` bag; the adapter expands the neutral intent
   * into its native mechanism per ADR-0273. Required — compile-time forcing so
   * no adapter silently omits it.
   */
  commandIntents: Record<RuntimeCommandIntentId, CommandIntentSupport>;

  /**
   * Every adapter declares its settings surface. A first-class structured
   * field per ADR-0256, not the `features` bag. Required — compile-time forcing
   * per the `commandIntents` precedent in this interface, so a new runtime
   * cannot silently omit it. Static only: account lists, current provider and
   * readiness stay on the refetched surfaces (`GET /api/config`,
   * `GET /api/system/requirements`) so capabilities remain safe to cache with
   * `staleTime: Infinity`.
   */
  settings: RuntimeSettingsCapability;

  /**
   * Context kinds this runtime injects natively (the server omits these from
   * the additionalContext bag to avoid double-injection). Effectively empty
   * for Claude under ADR-0273 A2 (native git is suppressed via
   * excludeDynamicSections). Retained as the general mechanism for future
   * runtimes that inject context they cannot suppress.
   */
  nativeContext: ContextKind[];

  /**
   * Whether the runtime holds ONE live session open across turns instead of
   * starting fresh work each time. A first-class boolean rather than a
   * `features` entry, which is what ADR-0256 asks for a capability that
   * genuinely is a boolean. Required — compile-time forcing per the
   * `commandIntents` precedent in this interface, not ADR-0256, which does not
   * decide that question — so a new adapter cannot silently omit it and inherit
   * a behavior it never declared (ADR `260816-143752`).
   *
   * Usually the prerequisite for the other two: a runtime whose every turn is
   * its OWN subprocess has nothing to steer into or stage onto between turns, so
   * it holds a process across turns FIRST. The dependency is architectural, not
   * absolute — an in-process runtime (test-mode) can steer a turn that is already
   * open and stage onto a transcript it owns without keeping a process warm
   * between turns, so it may declare {@link supportsSteer}/
   * {@link supportsContextStaging} `true` with this `false`. `false` for every
   * runtime through P2 of spec `persistent-session-runtime` — the shape lands
   * before any behavior does.
   */
  supportsPersistentSession: boolean;

  /**
   * Whether a message can be handed to the agent MID-TURN so it changes course
   * now, rather than waiting for the running turn to finish. Required, same
   * reason as {@link supportsPersistentSession}.
   *
   * `false` does not mean the message is refused: the server's queue always
   * accepts it, and the sender is told it was queued instead of steered.
   */
  supportsSteer: boolean;

  /**
   * Whether context can be put in front of the agent DURING a turn without
   * asking it to change course. Required, same reason as
   * {@link supportsPersistentSession}.
   *
   * `false` falls back to folding the text into the next dispatched message as
   * an additional-context entry, so nothing a person wrote is lost.
   */
  supportsContextStaging: boolean;

  // There is deliberately NO `supportsQueue`. The SERVER owns the queue for
  // every runtime, so queueing is not a capability an adapter declares — it is
  // true by construction, and a flag saying so could only ever be wrong.

  /**
   * Whether this runtime reconstructs message history from the DorkOS-owned
   * `EventLog` rather than a native transcript (codex, opencode, test-mode).
   * When `true`, the platform persists the runtime's completed-turn event
   * stream to the durable `session_events` store so history survives a server
   * restart (DOR-189). Claude-code omits it (`undefined`/`false`): its
   * transcript is SDK JSONL, and its `EventLog` is only gap-replay overflow —
   * persisting it would double-store and inflate the hot path. Optional so
   * existing capability objects stay valid; absent means "not log-backed".
   */
  logBackedHistory?: boolean;

  /**
   * Runtime-specific extension point for metadata that does not fit the
   * common shape. Consumers must validate what they read — see ADR 0256.
   */
  features: Record<string, unknown>;
}

/**
 * How warm a session's backing process is, for a runtime that keeps one alive
 * between turns (spec `persistent-session-runtime` §4.1).
 *
 * - `cold` — no process. Either none was ever started, or it was given back;
 *   the two are indistinguishable to a person, because the next message resumes
 *   the conversation either way.
 * - `warming` — a process is booting and cannot take a message yet.
 * - `warm` — a process is up with no turn open. This is the state the whole
 *   idea exists for, and it reports presence `idle`, never `streaming`.
 * - `running` — a turn is open on the warm process.
 * - `crashed` — the process died on its own; the next message starts a fresh
 *   one and resumes.
 */
export type SessionWarmth = 'cold' | 'warming' | 'warm' | 'running' | 'crashed';

/** Options for creating or resuming a session. */
export interface SessionOpts extends SessionSettings {
  /**
   * Required here: callers resolve the effective mode
   * (per-send override → persisted → runtime default) before creating.
   */
  permissionMode: PermissionMode;
  cwd?: string;
  hasStarted?: boolean;
  /**
   * True when nobody is watching this session — a scheduled task run.
   *
   * A prompt raised in an unattended session is refused at the ten-minute
   * countdown instead of waiting for somebody to answer it, because a wait is a
   * promise that somebody will come back and there is nobody here to keep it
   * (spec `ask-parks-on-timeout` §7). Absent, the default, means a person may
   * well be watching.
   *
   * Advisory: a runtime with no approval channel of its own simply ignores it.
   */
  unattended?: boolean;
}

/** Options for sending a message to a session. */
export interface MessageOpts extends SessionSettings {
  cwd?: string;
  systemPromptAppend?: string;
  /**
   * Neutral additional-context bag for this turn (git_status, ui_state,
   * queue_note, env, relay_context). Delivered OUT-OF-BAND relative to
   * `content`: the adapter MUST NOT mutate `content`, and injected context
   * MUST NEVER render as user-authored text (the adapter strips its tags on
   * render). The server owns WHAT context exists; the adapter owns HOW it is
   * rendered. See ADR-0273.
   */
  additionalContext?: AdditionalContext;
  /**
   * Title to assign the session on its first turn, skipping auto-generation.
   * Useful for sessions with a known purpose (e.g. Tasks- or relay-initiated runs).
   * Only honored on the first turn — ignored once the session has started.
   */
  title?: string;
  /**
   * How this message should reach a session that is ALREADY RUNNING a turn.
   * Absent means `'queue'`, the disposition every runtime supports. Ignored
   * when the session is idle — see {@link MessageDisposition}.
   */
  disposition?: MessageDisposition;
  /**
   * The server-minted id of the message being delivered.
   *
   * **Correlation is by id and NEVER positional.** A runtime with a persistent
   * session coalesces a dequeued batch into ONE turn, so three dispatched ids
   * can share a single `result` — "the nth result answers the nth message" is
   * false the first time two messages are dequeued together. Anything that
   * needs to know which message a piece of output belongs to must carry this id
   * through and match on it.
   */
  messageId?: string;
}

/**
 * Options for fulfilling a runtime command intent — a turn's {@link MessageOpts}
 * plus the intent's optional trailing instructions.
 */
export interface CommandIntentOpts extends MessageOpts {
  /**
   * Trailing instructions the user typed after the intent token (e.g.
   * `/compact focus on the API changes` → `'focus on the API changes'`).
   * Runtimes whose native mechanism accepts guidance forward them verbatim
   * (claude-code appends them to the bare `/compact`); runtimes whose mechanism
   * takes no instruction (opencode's `session.summarize`, test-mode's synthetic
   * boundary) ignore them — an honest per-runtime difference, not an error.
   */
  instructions?: string;
}

/**
 * The two ways a message can reach a session WITHOUT opening a turn of its own
 * (spec `persistent-session-runtime` §2.3). Both are non-turn-opening by
 * definition — a `queue` disposition opens a turn and so is not here.
 *
 * - `'steer'` reaches a turn that is ALREADY running and joins it.
 * - `'stage'` reaches the transcript without provoking any turn at all.
 */
export type DeliverMode = 'steer' | 'stage';

/** Inputs for {@link AgentRuntime.deliverIntoTurn}. */
export interface DeliverIntoTurnOpts {
  /** `'steer'` reaches the live turn; `'stage'` reaches the transcript only. */
  mode: DeliverMode;
  /**
   * The server-minted correlation id for this delivery (see
   * {@link MessageOpts.messageId}). A steer joins a turn whose `result` is
   * matched back by id, so the id is how the runtime tells the steered message
   * apart from the one that opened the turn.
   */
  messageId: string;
  /**
   * The neutral additional-context bag, assembled server-side EXACTLY as for a
   * turn (ADR-0273). The adapter renders it out of band; it never mutates
   * `content`, and injected context never renders as user-authored text.
   */
  additionalContext?: AdditionalContext;
}

/**
 * The receipt {@link AgentRuntime.deliverIntoTurn} returns — what the runtime
 * did, never a stream. A steer's resulting events surface on the ALREADY-open
 * turn's stream, which is why this is a receipt and not a generator (see the
 * method's own docs, trap (a)).
 */
export interface RuntimeDeliveryResult {
  /** True when the content reached the backend. */
  delivered: boolean;
  /**
   * Why not, present only when `delivered` is false.
   *
   * - `'no-open-turn'` — a steer arrived with no turn open to join (either none
   *   was ever open, or it closed between acceptance and delivery).
   * - `'stream-closed'` — the process's input stream had already ended, so
   *   nothing could be pushed into it.
   * - `'unsupported'` — this runtime does not implement the requested mode.
   */
  reason?: 'no-open-turn' | 'stream-closed' | 'unsupported';
}

/**
 * Who answered a prompt, for the receipt every other window draws.
 *
 * Shared by all three ways of answering — a permission prompt, a question, an
 * elicitation — because they are one object to whoever is being asked, and a
 * receipt that named the answerer for one of them and not the others would read
 * as a bug rather than as a distinction.
 *
 * The runtime never invents this. Only the caller that took the answer knows who
 * gave it, so it is passed in; a runtime with nobody to name simply omits it and
 * the receipt says "Already answered at 2:01" instead.
 */
export interface InteractionAnswerOptions {
  /**
   * A label for the person who answered, when the caller knows one — the name
   * this install knows them by. Never an id, and never a placeholder: the
   * receipt prints it verbatim, so an unknown answerer is better left unnamed.
   */
  answeredBy?: string;
}

/**
 * How a tool-approval decision was made, beyond allow-versus-deny.
 *
 * One object rather than two trailing positional flags, because the two fields
 * belong to opposite answers: `alwaysAllow` only means something on an
 * approval, `denyReason` only on a refusal. A caller passes the one that fits
 * its answer instead of padding the other with `undefined`.
 */
export interface ToolDecisionOptions extends InteractionAnswerOptions {
  /**
   * Approve persistently — forwards the runtime's own permission suggestions so
   * the same call is not asked about again. Ignored on a denial.
   */
  alwaysAllow?: boolean;
  /**
   * Why the person refused, in their own words, delivered to the agent with the
   * denial so it can adjust rather than retry. Ignored on an approval, and
   * absent whenever nobody said anything — the transcript receipt only claims
   * the agent was told why when this was actually carried.
   */
  denyReason?: string;
}

/**
 * Universal contract for agent backends.
 *
 * All session lifecycle, messaging, storage queries, and synchronization operations
 * are expressed through this interface. Routes and services depend only on
 * `AgentRuntime`, never on a specific implementation like `ClaudeCodeRuntime`.
 */
export interface AgentRuntime {
  /** Runtime type identifier, e.g. 'claude-code' */
  readonly type: string;

  // --- Session lifecycle ---

  /** Create or resume a session. */
  ensureSession(sessionId: string, opts: SessionOpts): void;

  /** Return true if the session is currently tracked in memory. */
  hasSession(sessionId: string): boolean;

  /**
   * Fork a session, creating a new independent copy of the conversation.
   *
   * @param projectDir - Project directory for transcript lookup
   * @param sessionId - Session to fork
   * @param opts - Optional fork parameters (upToMessageId, title)
   * @returns The new forked session, or null if the source session was not found
   */
  forkSession(
    projectDir: string,
    sessionId: string,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null>;

  /** Update mutable session fields. Returns false if the session does not exist. */
  updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
    }
  ): boolean | Promise<boolean>;

  /**
   * Rename a session by setting a custom title.
   * Persists to the SDK's JSONL via `renameSession()`.
   *
   * @param sessionId - Session to rename
   * @param title - New display title
   * @param projectDir - Project directory for JSONL resolution
   */
  renameSession(sessionId: string, title: string, projectDir: string): Promise<void>;

  // --- Messaging ---

  /**
   * Send a user message and stream back response events.
   *
   * Single-flight per session: callers must not invoke `sendMessage`
   * concurrently for the same `sessionId` — the server's trigger-turn session
   * lock enforces this, so adapters may assume it.
   *
   * @param sessionId - The session to send the message to
   * @param content - User message text
   * @param opts - Optional overrides for permission mode, cwd, and system prompt
   */
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent>;

  /**
   * Fulfill a RUNTIME-fulfilled command intent (currently `compact`) for a
   * session, expanding the neutral intent into the runtime's native mechanism
   * (ADR-0273; e.g. Claude sends a bare `/compact`, OpenCode calls
   * `session.summarize`). Yields the resulting StreamEvents so the server drives
   * them through the durable session projector exactly like a turn — the client
   * learns of the compaction via `GET /api/sessions/:id/events` (e.g. a
   * `compact_boundary`). Called ONLY when
   * `getCapabilities().commandIntents[intent].supported`; a runtime that does
   * not support the intent may throw a typed unsupported error.
   *
   * @param sessionId - Target session.
   * @param intent - The runtime-fulfilled intent id.
   * @param opts - cwd, per-turn options, and the intent's optional trailing
   *   instructions ({@link CommandIntentOpts}).
   */
  executeCommandIntent(
    sessionId: string,
    intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent>;

  // --- Interactive flows ---

  /**
   * Approve or deny a pending tool call.
   *
   * @param sessionId - Target session
   * @param toolCallId - The tool call to approve/deny
   * @param approved - Whether to approve (true) or deny (false)
   * @param options - How the decision was made; see {@link ToolDecisionOptions}
   * @returns false if the session or interaction was not found
   */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options?: ToolDecisionOptions
  ): boolean;

  /**
   * Submit answers to a pending structured-question interaction.
   *
   * Answers use DorkOS's **canonical, runtime-neutral** format: keyed by question
   * **index** (`"0"`, `"1"`, …, matching the `question_prompt` event's `questions`
   * order), with each value the user's answer as a display string — multi-select
   * selections joined with `", "`. Each runtime translates this canonical shape
   * into whatever its backend expects (the Claude adapter, for example, re-keys by
   * question text). Keeping the translation inside the runtime keeps this contract
   * portable across backends.
   *
   * @param sessionId - Target session
   * @param toolCallId - The question tool call to answer
   * @param answers - Canonical answers keyed by question index
   * @param options - Who answered; see {@link InteractionAnswerOptions}
   * @returns false if the session or interaction was not found
   */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
    options?: InteractionAnswerOptions
  ): boolean;

  /**
   * Submit a response to an MCP elicitation prompt.
   *
   * @param sessionId - Target session
   * @param interactionId - The elicitation interaction to respond to
   * @param action - Accept, decline, or cancel the elicitation
   * @param content - Form field values (form mode only)
   * @param options - Who answered; see {@link InteractionAnswerOptions}
   * @returns false if the session or interaction was not found
   */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
    options?: InteractionAnswerOptions
  ): boolean;

  /**
   * Stop a running background task (agent or bash command).
   *
   * @param sessionId - Target session
   * @param taskId - The background task to stop
   * @returns true if the task was found and stopped, false otherwise
   */
  stopTask(sessionId: string, taskId: string): Promise<boolean>;

  /**
   * Interrupt the active query for a session.
   *
   * Attempts a graceful interrupt first (SDK `query.interrupt()`). If that fails,
   * escalates to a forceful close (SDK `query.close()`).
   *
   * @param sessionId - Target session
   * @returns true if the query was interrupted, false if no active query
   */
  interruptQuery(sessionId: string): Promise<boolean>;

  /**
   * Deliver a message into a session WITHOUT opening a turn of its own.
   *
   * Three things about this are traps, and each one is why the signature is the
   * shape it is:
   *
   * (a) **It returns a RECEIPT, not a generator.** A `'steer'`'s resulting
   *     events surface on the turn's ALREADY-open stream — the one another
   *     `feedProjector` call is already consuming as that turn. Returning a
   *     second turn-shaped `AsyncGenerator<StreamEvent>` here would mean two
   *     `feedProjector` calls fighting over one turn, so this hands back only
   *     what happened.
   * (b) **It is called ONLY when the matching capability is declared**
   *     (`supportsSteer` for `'steer'`, `supportsContextStaging` for `'stage'`).
   *     It is optional on the interface so a runtime that can do NEITHER simply
   *     omits it; the server's degradation ladder covers the gap, and a missing
   *     implementation is never an error the person sees.
   * (c) **It MUST NOT throw for an ordinary refusal.** No open turn, a closed
   *     stream, an unsupported mode — all are reported as
   *     `{ delivered: false, reason }`, because the server's job is to degrade
   *     (queue it instead, fold it into the next turn) rather than fail the
   *     person's message. A throw is reserved for a genuine fault, exactly as it
   *     is for {@link sendMessage}.
   *
   * `content` is the person's text, PRISTINE — never mutated. Any context rides
   * `opts.additionalContext` and is rendered out of band (ADR-0273). A steer is
   * a WRITE, subject to the SAME authorization as {@link sendMessage}: the
   * caller must be entitled to write to the session, and the server enforces
   * that before calling this.
   *
   * @param sessionId - Target session
   * @param content - The user's text, pristine; context rides `opts`
   * @param opts - The mode, the correlation id, and the neutral context bag
   * @returns A receipt saying whether the content reached the backend, and why
   *   not when it did not
   */
  deliverIntoTurn?(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult>;

  /**
   * Whether a steer sent to THIS session right now could actually join its live
   * turn — the per-session half of the per-runtime {@link
   * RuntimeCapabilities.supportsSteer}.
   *
   * The two are different questions, and conflating them is how a person gets
   * offered a cut-in that silently becomes an ordinary follow-up (DOR-1268).
   * `supportsSteer` says the ADAPTER can steer; this says whether the mechanism
   * that does it is actually under this session. Claude Code is the case that
   * forced the split: steering rides the persistent pump's held input stream, so
   * a session on the resume path — how a default install ships — has nothing to
   * push into, however capable the adapter is.
   *
   * Optional: a runtime whose steering is uniform across its sessions omits it,
   * and every consumer reads the absence as `supportsSteer`. It answers about
   * the MECHANISM, not about the moment: `true` on a session with no turn open
   * means "a turn here would be joinable", not "a turn is open".
   *
   * @param sessionId - Session to report on; either id a caller might hold
   */
  canSteerSession?(sessionId: string): boolean;

  /**
   * Whether a stage sent to THIS session right now could reach the runtime's own
   * transcript — the per-session half of the per-runtime {@link
   * RuntimeCapabilities.supportsContextStaging}, and the exact counterpart of
   * {@link canSteerSession}.
   *
   * `supportsContextStaging` says the ADAPTER can append to its transcript; this
   * says whether the seam that does it is under this session right now. Claude
   * Code forced the split a second time (DOR-1307): its native stage rides the
   * persistent pump's held input stream, so a session on the resume path — how a
   * default install ships — has no transcript to append to. Answering `false`
   * there is what keeps the server from asking, because the adapter's only way to
   * say yes would be to START a process the operator never opted into.
   *
   * **A `false` is not a refusal.** The server folds the words into the next
   * dispatch instead (ADR-0273's neutral context bag) and reports
   * `degradedBecause: 'not-stageable'`, so a stage always lands. That is the
   * difference from {@link canSteerSession}, whose `false` means the composer
   * should not offer a cut-in at all: a fold is a real, useful answer, so Add
   * context stays offered on both paths and this method never reaches the client.
   *
   * Optional: a runtime whose staging is uniform across its sessions omits it,
   * and every consumer reads the absence as `supportsContextStaging`. It NARROWS
   * that flag and never widens it — a runtime declaring `false` has no stageable
   * session, and the server checks the flag first either way.
   *
   * @param sessionId - Session to report on; either id a caller might hold
   */
  canStageSession?(sessionId: string): boolean;

  /**
   * End a turn this session has left open, so the turn about to start does not
   * inherit it (DOR-1295).
   *
   * Called by the server ONCE per turn, before that turn's `turn_start` is
   * minted. Ordinary turns answer `false` — nothing was open — and pay one
   * method call.
   *
   * Optional, and only a runtime that can leave a turn open needs it. A backend
   * whose turn is bounded by the stream it hands back cannot strand one, so it
   * omits this and the server reads the absence as "nothing to settle".
   *
   * Three things a runtime that implements it owes the caller, all three held to
   * by conformance C8:
   *
   * - **The abandoned turn must still terminate on the session's stream.** The
   *   person watched a turn start; it has to be seen to end, as a failure. This
   *   settles it, it never hides it.
   * - **It must not throw for a session it knows nothing about**, including one
   *   that has never had a turn. Ending a turn nobody can finish is a repair,
   *   and a repair may not be the thing that fails the next message.
   * - **The answer is honest**: `false` when there was nothing to settle. It is
   *   the runtime's own account of what it did, read by the server for the log
   *   line that explains why a person's previous reply just went red. The
   *   server does NOT decide whether to wait from it — it waits on the
   *   projection either way — so a runtime cannot skip the ordering guarantee by
   *   answering `false`, and cannot buy extra delay by answering `true`.
   *
   * @param sessionId - The session about to open a turn
   * @returns Whether an open turn was found and settled
   */
  settleOpenTurn?(sessionId: string): Promise<boolean>;

  /**
   * How warm this session's backing process is, for a runtime that keeps one
   * alive between turns.
   *
   * Optional: a runtime that starts fresh work every turn has no warm concept
   * and simply omits it, which reads as `'cold'` everywhere. A runtime that
   * implements it must answer `'cold'` for a session it holds no process for,
   * including one it has never heard of.
   *
   * Warmth is invisible to the person by design — it changes how fast a turn
   * starts, never what happens — so this exists for conformance and diagnostics
   * rather than for the UI. In particular, a WARM session is `idle`, never
   * `streaming`: it is not a turn and has nothing in progress.
   *
   * @param sessionId - Session to report on
   */
  getSessionWarmth?(sessionId: string): SessionWarmth;

  /**
   * Close a session's warm process without touching the session record or its
   * transcript.
   *
   * Idempotent, and a no-op when the session is not warm. Invisible to the
   * person: the next message resumes the conversation exactly as if the process
   * had still been there, only slower.
   *
   * **Never call it while a pending interaction is open.** A reaped process
   * cannot answer the approval the person comes back to, and
   * `INTERACTION_TIMEOUT_MS` (10 min) outlasts the warm idle window (5 min), so
   * that race is real rather than theoretical.
   *
   * @param sessionId - Session whose process should be given back
   */
  reapSession?(sessionId: string): Promise<void>;

  // --- Session queries (storage) ---

  /** List all sessions for a project directory. */
  listSessions(projectDir: string): Promise<Session[]>;

  /**
   * List sessions for a project directory AND report the stores that could not
   * be read, when a runtime reads from more than one store and can lose part of
   * its own history without failing.
   *
   * ADR-0310 already degrades per RUNTIME: a rejected `listSessions` becomes one
   * `warnings[]` entry and zero sessions. A runtime whose history is spread
   * across several stores needs the same honesty one level down — claude-code
   * reads one store per Claude account, and an account it cannot read must cost
   * that account's sessions, not the whole runtime's. Rejecting would throw away
   * the accounts that ARE readable; returning a short list silently would look
   * exactly like a complete one, which is the failure this reporting exists to
   * prevent (spec `claude-code-accounts` §6).
   *
   * Optional: a single-store runtime implements only `listSessions` and
   * aggregation treats it as "no partial failures possible". A runtime that
   * implements this method should treat `listSessions` as the same read with the
   * warnings dropped, so the two can never disagree about the sessions.
   *
   * @param projectDir - Working directory to list sessions for
   * @returns The merged sessions plus one warning per unreadable store
   */
  listSessionsWithWarnings?(
    projectDir: string
  ): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }>;

  /** Get metadata for a single session, or null if not found. */
  getSession(projectDir: string, sessionId: string): Promise<Session | null>;

  /** Read the full message history for a session. */
  getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]>;

  /**
   * The authoritative current state of a session: completed messages, the
   * in-progress turn's events, status projection, pending interactions, and the
   * snapshot cursor (highest seq reflected). The adapter decides where messages
   * come from (Claude: loadHistory() from JSONL; stateless: the DorkOS EventLog).
   *
   * @param ctx - Session context (carries projectDir/cwd and resolved settings)
   * @param sessionId - Target session ID
   */
  getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot>;

  /**
   * Normalized, monotonically-seq'd events for one session. The adapter maps its
   * native source (Claude: file-watch + the in-band SDK query; stub: its in-process
   * turn loop) into this stream. Pass sinceCursor to resume after a gap.
   *
   * Throws {@link StaleResumeCursorError} EAGERLY (at call time, before any
   * iteration) when `sinceCursor` cannot be served gap-free — it is ahead of
   * the session's current seq (seq space reset, e.g. server restart) or below
   * the adapter's replay floor (buffer trimmed past it). Callers MUST catch it
   * and fall back to the cold path (fresh snapshot, then subscribe from its
   * cursor) instead of resuming.
   *
   * @param ctx - Session context (carries projectDir/cwd and resolved settings)
   * @param sessionId - Target session ID
   * @param sinceCursor - Resume point; emit only events with `seq` greater than this
   * @param signal - Aborts the stream so a parked consumer terminates promptly
   *   (e.g. on client disconnect), letting the adapter run its cleanup. A bare
   *   `iterator.return()` cannot interrupt a generator parked on an un-settleable
   *   wait, so the abort is the deterministic teardown path.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent>;

  /**
   * Discovery + liveness across ALL sessions the adapter can observe, including
   * externally-driven ones (Claude adapter watches ~/.claude/projects; future
   * adapters expose their own). Feeds the global status stream.
   *
   * @param ctx - Session context (carries projectDir/cwd and resolved settings)
   */
  subscribeSessionList(ctx: SessionOpts): AsyncIterable<SessionListEvent>;

  /** Read task items from a session transcript. */
  getSessionTasks(projectDir: string, sessionId: string): Promise<TaskItem[]>;

  /** Get the ETag for a session's transcript (for conditional HTTP responses). */
  getSessionETag(projectDir: string, sessionId: string): Promise<string | null>;

  /**
   * Return the JSONL-assigned message IDs for the last user and assistant
   * messages in a session. Used for client-server ID reconciliation.
   *
   * @param sessionId - Session to query
   * @returns ID pair or null if not available
   */
  getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null>;

  /**
   * Read new content from a session transcript starting at a byte offset.
   *
   * @param projectDir - Project directory for transcript lookup
   * @param sessionId - Target session ID
   * @param offset - Byte offset to start reading from
   * @returns New content and the updated byte offset
   */
  readFromOffset(
    projectDir: string,
    sessionId: string,
    offset: number
  ): Promise<{ content: string; newOffset: number }>;

  // --- Session locking ---

  /**
   * Attempt to acquire an exclusive write lock for a session.
   *
   * @param sessionId - Session to lock
   * @param clientId - Identifying string for the lock holder
   * @param res - SSE response to release the lock when the connection closes
   * @param token - Optional per-acquisition identity. When threaded into
   *   {@link releaseLock}, release is token-matched so a stale releaser from a
   *   superseded same-client turn cannot drop a newer lock.
   * @returns true if the lock was acquired, false if already held by another client
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;

  /**
   * Release the lock held by a specific client. No-op if not locked by that
   * client, or — when `token` is supplied — if it does not match the current
   * lock's token.
   */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;

  /**
   * Check whether a session is currently locked.
   *
   * @param sessionId - Session to check
   * @param clientId - If provided, returns true only if locked by a different client
   */
  isLocked(sessionId: string, clientId?: string): boolean;

  /** Get lock metadata, or null if the session is not locked. */
  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null;

  // --- Capabilities ---

  /** Return available models for this runtime. */
  getSupportedModels(): Promise<ModelOption[]>;

  /** Return available subagents reported by the SDK. */
  getSupportedSubagents(): Promise<SubagentInfo[]>;

  /** Return static capability flags for this runtime. */
  getCapabilities(): RuntimeCapabilities;

  /** Check whether this runtime's external dependencies are satisfied. */
  checkDependencies(): Promise<DependencyCheck[]>;

  /**
   * The currently connected provider id for a runtime whose auth is
   * provider-agnostic (OpenCode reads `runtimes.opencode.provider`). Surfaced on
   * `GET /api/system/requirements` so the client can label a "Change power
   * source" affordance with the current source. Returns `null` when no DorkOS
   * provider is set (e.g. the runtime was authenticated outside DorkOS). Runtimes
   * with no provider concept omit this method entirely.
   */
  getConnectedProvider?(): string | null;

  // --- Commands ---

  /**
   * Return the command registry for this runtime.
   *
   * @param forceRefresh - If true, bypass the cache and re-scan
   * @param cwd - Optional working directory for per-directory command resolution
   */
  getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry>;

  // --- Lifecycle ---

  /** Evict sessions that have exceeded their idle timeout. */
  checkSessionHealth(): void;

  /**
   * Return the backend-internal session ID for a given DorkOS session ID.
   * For Claude Code this is the SDK session ID used in JSONL filenames.
   */
  getInternalSessionId(sessionId: string): string | undefined;

  // --- Conventions (optional) ---

  /**
   * Apply personality and safety convention content to an agent session.
   * Called by the server before session start. Each runtime implements
   * its own injection mechanism.
   *
   * @param persona - Rendered SOUL.md content (traits + custom prose), or null if disabled
   * @param safetyBoundaries - NOPE.md content, or null if disabled
   * @param agentPath - Absolute path to the agent's working directory
   */
  applyConventions?(
    persona: string | null,
    safetyBoundaries: string | null,
    agentPath: string
  ): Promise<void>;

  // --- Tool server (optional) ---

  /** Return the MCP tool server config, if this runtime supports it. */
  getToolServerConfig?(): Record<string, unknown>;

  /** Register a factory that produces a fresh MCP tool server per query. */
  setMcpServerFactory?(factory: () => Record<string, unknown>): void;

  /**
   * Return last-known MCP server status for a project path, or null if not yet available.
   *
   * Implement this to surface live connectivity status (connected/failed/pending) in the UI.
   * The default fallback is `.mcp.json` config-only parsing (no connectivity data).
   *
   * @param cwd - Absolute project directory path
   */
  getMcpStatus?(cwd: string): import('./transport.js').McpServerEntry[] | null;

  /**
   * Return the resolved connection config for one MCP server, or null if the
   * runtime has not captured it (no message sent yet, unknown server, or a
   * transport this host cannot independently reconnect — e.g. claude.ai proxy).
   *
   * This exposes the runtime's already-resolved MCP connection details so the
   * DorkOS server can open its own short-lived MCP client to read `ui://` App
   * resources (MCP Apps / SEP-1865; ADR `260708-141143`). The returned config is
   * **server-only** and never travels to the browser client — it carries stdio
   * command/env. Runtime-neutral (no SDK types) so consumers stay SDK-agnostic.
   *
   * @param cwd - Absolute project directory path (same key as `getMcpStatus`).
   * @param serverName - MCP server name as configured.
   */
  getMcpServerConfig?(cwd: string, serverName: string): McpAppServerConnection | null;

  /**
   * Reload plugins from disk for a given session and return refreshed status.
   *
   * Requires a Query object from a prior SDK session. Returns null if no query is available
   * (e.g. no message has been sent yet in this session).
   *
   * @param sessionId - Session with an existing SDK query
   */
  reloadPlugins?(sessionId: string): Promise<ReloadPluginsResult | null>;

  // --- Dependency injection (optional) ---

  /** Inject an agent registry for peer-agent context and agent manifest resolution. */
  setMeshCore?(meshCore: AgentRegistryPort): void;

  /**
   * Inject the resolver for an agent's managed MCP servers, so a runtime that
   * declares `supportsManagedMcpServers` can fold them into each session
   * (spec `mcp-server-management`). Claude-code uses its own MCP factory seam
   * instead and does not implement this; Codex does (DOR-892).
   */
  setManagedMcpServers?(resolver: ManagedMcpServerResolver): void;

  /** Inject a relay instance for Relay-aware context building. */
  setRelay?(relay: RelayPort): void;

  /** Inject the core session-settings store for durable hydrate/write-through. */
  setSessionSettings?(port: SessionSettingsPort): void;
}
