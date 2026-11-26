/**
 * Agent facts (spec `computer-side-starts-alone` §5.3, port P3): what a
 * computer must know about an agent to run its turn, read through one port
 * instead of from the space side's agent registry, memory, relay, canvas and
 * tasks code.
 *
 * Two plain-data objects:
 *
 * - {@link AgentFacts}, the `agents.sync` put body (manifest, identity files,
 *   packages; `session-relay-agent-computer.ts`) plus the agent's home, its
 *   desks (the managed checkouts it owns) and its author id;
 * - {@link TurnPromptFacts}, the process-wide switches a turn's prompt reads:
 *   whether Tasks and Relay are on, and whether the memory provider is benched.
 *
 * The port, {@link AgentFactsPort}, also answers the questions a computer asks
 * about a folder or a chat (whose home is this folder, may git run here, may
 * this agent work here, which agent is this chat's) and renders the few prompt
 * blocks whose words are the space side's (document events, the task frame,
 * the agent browser's notice, the memory snapshot and notes line). Every
 * argument and every answer is plain data, so each method can become one call
 * over a wire later (I7). The agent's token for DorkOS's own CLI is minted by
 * the space side for each launch ({@link AgentFactsPort.launchTokenEnv}); it is
 * never part of the facts.
 *
 * Each computer-side folder that reads facts keeps a slot that startup fills
 * ({@link createAgentFactsSlot}). Unwired, the port fails closed
 * ({@link UNWIRED_AGENT_FACTS}): no folder is anybody's home, git runs nowhere,
 * no desk is an agent's, no token is minted, and a renderer throws and names
 * the missing wiring rather than leave a block out.
 *
 * The pure helpers every reader of a home needs ({@link homeOf},
 * {@link turnAgentOf}, {@link readHomeManifest}, {@link canonicalDir}) live
 * here, so both sides use one copy.
 *
 * @module shared/agent-facts
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CanvasChannelDocEventsContext } from './canvas-channel-schemas.js';
import { readManifest } from './manifest.js';
import type { MemorySnapshot } from './memory-provider.js';
import { AgentsSyncPutSchema } from './session-relay-agent-computer.js';
import type { Task, TaskRun } from './types.js';

// === Homes ===

/**
 * A registered agent home. Only the space side's resolver mints one (through
 * {@link AgentFactsPort.home}), so an identity reader that takes this type
 * cannot be handed a working directory.
 */
export type AgentHome = string & { readonly __brand: 'AgentHome' };

/** An {@link AgentHome} as it crosses: a non-empty absolute path. */
export const AgentHomeSchema = z.custom<AgentHome>(
  (value) => typeof value === 'string' && value.length > 0 && path.isAbsolute(value),
  { message: 'An agent home is an absolute path' }
);

/** How a folder resolved to a home. */
export const HomeViaSchema = z.enum([
  'exact',
  'managed-workspace',
  'linked-worktree',
  'turn-agent',
]);

/** How a folder resolved to a home. */
export type HomeVia = z.infer<typeof HomeViaSchema>;

/**
 * The answer for one folder.
 *
 * - `home`: identity comes from `home`.
 * - `none`: no agent, a session about a directory.
 * - `refused`: the folder is some agent's, and it cannot be shown to be the
 *   turn's. Acts as nobody, and never as the operator.
 */
export const HomeResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home'), home: AgentHomeSchema, via: HomeViaSchema }),
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('refused'),
    reason: z.enum(['not-the-turns-agent', 'unregistered-owner']),
  }),
]);

/** The answer for one folder. See {@link HomeResolutionSchema}. */
export type HomeResolution =
  | { kind: 'home'; home: AgentHome; via: HomeVia }
  | { kind: 'none' }
  | { kind: 'refused'; reason: 'not-the-turns-agent' | 'unregistered-owner' };

/**
 * How the turn's folder was chosen, as the desk guard needs to know it.
 *
 * - `home`: the agent's own home was asked for (the default binding, and
 *   every room turn).
 * - `managed`: the agent's manifest asked for a checkout of its own.
 * - `none`: the agent is configured `workspace.mode: 'none'` and shares the
 *   operator's default folder.
 * - `boundary-refused`: the agent's home is outside what this server may
 *   touch, so the default folder answered instead.
 */
export const DeskBindingSchema = z.enum(['home', 'managed', 'none', 'boundary-refused']);

/** How a turn's desk was bound. See {@link DeskBindingSchema}. */
export type DeskBinding = z.infer<typeof DeskBindingSchema>;

/**
 * Why an agent may not work in a folder, in plain words, as the space side's
 * desk guard said it. A computer that gets one does not start the turn.
 */
export const DeskRefusalSchema = z.strictObject({
  /** What happened and what to change. */
  message: z.string().min(1),
  /** The folder that was refused, resolved. */
  cwd: z.string().min(1),
  /** The home of the agent the turn was for. */
  forAgent: z.string(),
});

/** Why an agent may not work in a folder. See {@link DeskRefusalSchema}. */
export type DeskRefusal = z.infer<typeof DeskRefusalSchema>;

/**
 * The resolved home, or `undefined` when there is none to read identity from.
 *
 * @param resolution - A resolved folder.
 */
export function homeOf(resolution: HomeResolution): AgentHome | undefined {
  return resolution.kind === 'home' ? resolution.home : undefined;
}

/**
 * The agent a turn is dispatched as: the neutral `forAgent`, else the room
 * marker's `agentPath` (the field `forAgent` generalises).
 *
 * @param opts - The turn's message options.
 */
export function turnAgentOf(
  opts: { forAgent?: string; roomTurn?: { agentPath?: string } } | undefined
): string | undefined {
  return opts?.forAgent ?? opts?.roomTurn?.agentPath;
}

/**
 * Read an agent's manifest from its home: the server's only door to
 * `.dork/agent.json` for identity. `@dorkos/shared/manifest` keeps its string
 * signature for the CLI and other packages.
 *
 * @param home - A resolved home.
 */
export function readHomeManifest(home: AgentHome): ReturnType<typeof readManifest> {
  return readManifest(home);
}

/**
 * A folder's canonical spelling: its real path when it exists, else the path
 * resolved, so two spellings of one folder compare equal.
 *
 * @param dir - Any folder.
 */
export function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The environment variable an agent's DorkOS CLI token rides in. The token is
 * minted for each launch ({@link AgentFactsPort.launchTokenEnv}) and never
 * logged.
 */
export const AGENT_TOKEN_ENV_VAR = 'DORKOS_AGENT_TOKEN';

// === The facts ===

/**
 * One agent, as a computer knows it: the `agents.sync` put body plus where it
 * lives and who it is in rooms.
 */
export const AgentFactsSchema = AgentsSyncPutSchema.safeExtend({
  /** The agent's home: the folder it is registered at. */
  home: AgentHomeSchema,
  /** The managed checkouts it owns, each a folder it may work in. */
  desks: z.array(z.string().min(1)),
  /** Its author id in rooms, or `null` before it has spoken anywhere. */
  authorId: z.string().min(1).nullable(),
});

/** One agent, as a computer knows it. See {@link AgentFactsSchema}. */
export type AgentFacts = z.infer<typeof AgentFactsSchema>;

/** Who a running agent is, for a tool call's attribution. */
export const AgentIdentityFactSchema = z.strictObject({
  /** The agent's home: its stable identity. */
  agentPath: z.string().min(1),
  /** The name a person reads. */
  displayName: z.string(),
  /** When its token was minted, or the agent registered. ISO 8601 UTC. */
  createdAt: z.string(),
  /** Why it is known but no longer acting as itself, or absent when live. */
  inactive: z.enum(['revoked', 'expired']).optional(),
  /** The chat a live process holding its token runs, when known. */
  chatId: z.string().optional(),
});

/** Who a running agent is. See {@link AgentIdentityFactSchema}. */
export type AgentIdentityFact = z.infer<typeof AgentIdentityFactSchema>;

/** The process-wide switches a turn's prompt reads. */
export const TurnPromptFactsSchema = z.strictObject({
  /** Whether DorkOS Tasks is on. */
  tasksEnabled: z.boolean(),
  /** Whether Relay is on. */
  relayEnabled: z.boolean(),
  /** Whether the configured memory provider is benched, so the built-in one answers. */
  memoryBenched: z.boolean(),
});

/** The process-wide switches a turn's prompt reads. See {@link TurnPromptFactsSchema}. */
export type TurnPromptFacts = z.infer<typeof TurnPromptFactsSchema>;

// === Relay connections, as the Claude Code prompt reads them ===

/** One relay binding of an agent to an adapter. */
export const RelayBindingFactSchema = z.object({
  /** The binding's id. */
  id: z.string(),
  /** The adapter it binds to. */
  adapterId: z.string(),
  /** The agent it binds. */
  agentId: z.string(),
  /** Whether the agent may message first on it. */
  canInitiate: z.boolean().optional(),
});

/** One relay binding. See {@link RelayBindingFactSchema}. */
export type RelayBindingFact = z.infer<typeof RelayBindingFactSchema>;

/** One chat a binding has open: a person's own session, or a chat's. */
export const RelayBindingSessionFactSchema = z.object({
  /** Whether the session is one person's or one chat's. */
  scope: z.string(),
  /** The person, for a per-person session. */
  userId: z.string().optional(),
  /** The chat, for a per-chat session. */
  chatId: z.string().optional(),
});

/** One chat a binding has open. See {@link RelayBindingSessionFactSchema}. */
export type RelayBindingSessionFact = z.infer<typeof RelayBindingSessionFactSchema>;

/** One relay adapter, as the prompt names it. */
export const RelayAdapterFactSchema = z.object({
  config: z.object({
    /** The adapter's id. */
    id: z.string(),
    /** Its kind (`telegram`, `slack`, …). */
    type: z.string(),
    /** The name a person gave it. */
    label: z.string().optional(),
  }),
  status: z.object({
    /** Whether it is connected. */
    state: z.string(),
  }),
});

/** One relay adapter. See {@link RelayAdapterFactSchema}. */
export type RelayAdapterFact = z.infer<typeof RelayAdapterFactSchema>;

/**
 * Where the Claude Code runtime reads an agent's relay connections from: the
 * bindings, the chats each has open and the adapters. Each answer is plain
 * data; the relay's own stores satisfy it.
 */
export interface RelayConnectionsSource {
  /** Every binding. */
  bindings: { getAll(): readonly RelayBindingFact[] };
  /** The chats one binding has open. */
  sessions: { getSessionsByBinding(bindingId: string): readonly RelayBindingSessionFact[] };
  /** Every adapter. */
  adapters: { listAdapters(): readonly RelayAdapterFact[] };
}

// === Packages, as a harness reads them ===

/** One marketplace source DorkOS knows, by its name. */
export const PackageSourceFactSchema = z.strictObject({
  /** The source's name. */
  name: z.string().min(1),
  /** Where it is fetched from. */
  source: z.string().min(1),
});

/** One marketplace source. See {@link PackageSourceFactSchema}. */
export type PackageSourceFact = z.infer<typeof PackageSourceFactSchema>;

/** One package DorkOS installed into a project, as its install index records it. */
export const ProjectInstallFactSchema = z.object({
  /** The project it was installed into. */
  projectPath: z.string(),
  /** Its install root inside that project. */
  installRoot: z.string(),
  /** The package name the install recorded. */
  name: z.string(),
  /** The digest of the install folder as the installer staged it, when recorded. */
  installDigest: z.string().optional(),
});

/** One installed package. See {@link ProjectInstallFactSchema}. */
export type ProjectInstallFact = z.infer<typeof ProjectInstallFactSchema>;

/** An install folder's digest now, or why there is none. */
export const InstallDigestFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('digest'), digest: z.string() }),
  z.strictObject({ kind: z.literal('linked') }),
  z.strictObject({ kind: z.literal('unreadable') }),
]);

/** An install folder's digest now. See {@link InstallDigestFactSchema}. */
export type InstallDigestFact = z.infer<typeof InstallDigestFactSchema>;

/**
 * What a harness reads about DorkOS's packages: the sources, each source's
 * cached package names, the install index and an install folder's digest.
 * Each method rejects when what it reads cannot be read, as the files
 * themselves do.
 */
export interface PackageFactsPort {
  /** Every marketplace source DorkOS knows. */
  packageSources(dorkHome: string): Promise<PackageSourceFact[]>;
  /** The package names one source's cached catalog lists, or `null` when none is cached. */
  cachedPackageNames(dorkHome: string, sourceName: string): Promise<string[] | null>;
  /** Every package DorkOS installed into a project. */
  projectInstalls(dorkHome: string): Promise<ProjectInstallFact[]>;
  /** An install folder's digest now. */
  installDigest(installRoot: string): Promise<InstallDigestFact>;
}

// === The port ===

/** Why an agent's browser will not be signed in anywhere. */
export const AgentBrowserGapSchema = z.enum(['missing', 'empty']);

/** Why an agent's browser will not be signed in anywhere. See {@link AgentBrowserGapSchema}. */
export type AgentBrowserGap = z.infer<typeof AgentBrowserGapSchema>;

/** The agent facts port, as computer-side code holds it. */
export interface AgentFactsPort extends PackageFactsPort {
  /** One agent's facts by its id, or `null` when no agent has it. */
  get(agentId: string): Promise<AgentFacts | null>;
  /** Every registered agent's facts. */
  list(): Promise<AgentFacts[]>;
  /**
   * The home of the agent a chat belongs to, or `undefined` when it has none.
   * Rejects when the record cannot be read; callers decide what that means.
   */
  ofChat(sessionId: string): Promise<string | undefined>;
  /** The folder a chat's turns stand in, or `undefined` when none is known. */
  folderOfChat(sessionId: string): string | undefined;
  /**
   * Whose home a folder is (spec `agent-home-desk` §3). Synchronous and cheap.
   *
   * @param dir - Where the turn stands, or `undefined` when nothing names it.
   * @param forAgent - The home of the agent the turn is dispatched as, when a
   *   server path names one.
   */
  home(dir: string | undefined, forAgent?: string): HomeResolution;
  /** Whether a folder is inside the rooms' own files, where no agent ever works. */
  insideRoomsDir(dir: string): boolean;
  /** The git kill switch: whether DorkOS may run `git` in a folder at all. */
  mayRunGit(dir: string): boolean;
  /**
   * Why `forAgent` may not work in `cwd`, or `null` when it may (the desk guard).
   *
   * @param forAgent - The home of the agent the turn is for.
   * @param cwd - Where the turn would stand.
   * @param binding - How the desk was bound.
   * @param defaultCwd - The shared default folder, when not the server's own.
   */
  deskRefusal(
    forAgent: string,
    cwd: string,
    binding: DeskBinding,
    defaultCwd?: string
  ): DeskRefusal | null;
  /** Who an agent is, for a tool call's attribution, or `undefined` when unknown. */
  describeAgent(agentPath: string): Promise<AgentIdentityFact | undefined>;
  /**
   * The environment that hands one launch the agent's DorkOS CLI token, minted
   * by the space side now and recorded in its audit trail. `{}` when there is
   * no agent or no token could be minted.
   */
  launchTokenEnv(
    agentPath: string | undefined,
    displayName: string | undefined
  ): Promise<Record<string, string>>;
  /** The switches a turn's prompt reads now. */
  promptFacts(): TurnPromptFacts;
  /** An agent's memory snapshot. */
  memorySnapshot(agentId: string, home: AgentHome): Promise<MemorySnapshot>;
  /** The one line pointing at an agent's notes files, or `''`. May reject. */
  memoryNotesLine(agentId: string, home: AgentHome): Promise<string>;
  /** A turn's document events, fenced as untrusted data. */
  renderDocEvents(context: CanvasChannelDocEventsContext): string;
  /** The scheduler frame a task run is told. */
  taskAppend(task: Task, run: TaskRun): string;
  /** The folder a chat's document is drawn from, or `undefined`. */
  documentFilePath(sessionId: string, documentId: string): string | undefined;
  /**
   * Whether an agent browser's saved session file leaves it signed in to
   * nothing: `'missing'`, `'empty'`, or `null` when a site is saved.
   */
  agentBrowserGap(stateFile: string): AgentBrowserGap | null;
  /** The line an agent reads about its browser's gap, or `''` for `null`. */
  agentBrowserNotice(gap: AgentBrowserGap | null): string;
  /** The agent browser's saved session file under a DorkOS data directory. */
  agentBrowserStateFile(dorkHome: string): string;
  /**
   * Write an empty saved session file for an agent browser server, when it
   * has none. Whether one was written.
   */
  ensureAgentBrowserStateFile(
    connection: { transport: string; args?: readonly string[] },
    dorkHome: string
  ): boolean;
  /** The global packages a person approved, or that run nothing on their own. */
  consentedGlobalPackages(dorkHome: string): Promise<string[]>;
}

/** The message every unwired renderer throws with. */
export const AGENT_FACTS_UNWIRED =
  'Agent facts are not wired: startup hands the computer side its agent facts before any turn runs (startup/agent-facts.ts).';

const unwired = (): never => {
  throw new Error(AGENT_FACTS_UNWIRED);
};

/**
 * The port before a space side wires it. It fails closed: no agent, no folder
 * is anybody's home (a turn for a named agent is refused), git runs nowhere,
 * no desk is an agent's, no token, every switch off, and each renderer and
 * package read throws {@link AGENT_FACTS_UNWIRED}.
 */
export const UNWIRED_AGENT_FACTS: AgentFactsPort = Object.freeze({
  get: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
  ofChat: () => Promise.resolve(undefined),
  folderOfChat: () => undefined,
  home: (_dir: string | undefined, forAgent?: string): HomeResolution =>
    forAgent === undefined ? { kind: 'none' } : { kind: 'refused', reason: 'unregistered-owner' },
  insideRoomsDir: () => false,
  mayRunGit: () => false,
  deskRefusal: (forAgent: string, cwd: string): DeskRefusal => ({
    message: AGENT_FACTS_UNWIRED,
    cwd: path.resolve(cwd),
    forAgent,
  }),
  describeAgent: () => Promise.resolve(undefined),
  launchTokenEnv: () => Promise.resolve({}),
  promptFacts: () => ({ tasksEnabled: false, relayEnabled: false, memoryBenched: false }),
  memorySnapshot: () => Promise.reject(new Error(AGENT_FACTS_UNWIRED)),
  memoryNotesLine: () => Promise.reject(new Error(AGENT_FACTS_UNWIRED)),
  renderDocEvents: unwired,
  taskAppend: unwired,
  documentFilePath: () => undefined,
  agentBrowserGap: unwired,
  agentBrowserNotice: unwired,
  agentBrowserStateFile: unwired,
  ensureAgentBrowserStateFile: () => false,
  consentedGlobalPackages: () => Promise.reject(new Error(AGENT_FACTS_UNWIRED)),
  packageSources: () => Promise.reject(new Error(AGENT_FACTS_UNWIRED)),
  cachedPackageNames: () => Promise.reject(new Error(AGENT_FACTS_UNWIRED)),
  projectInstalls: () => Promise.reject(new Error(AGENT_FACTS_UNWIRED)),
  installDigest: () => Promise.resolve({ kind: 'unreadable' as const }),
});

/** A holder for a port, filled at startup; reads its unwired port until then. */
export interface FactsSlot<T> {
  /**
   * Hand over the port, or clear it.
   *
   * @param next - The port, or `undefined` to clear it.
   */
  set(next: T | undefined): void;
  /** The port, or the unwired one when none is set. */
  get(): T;
  /** Whether a port is set. */
  wired(): boolean;
}

function slotOf<T>(unwiredPort: T): FactsSlot<T> {
  let held: T | undefined;
  return {
    set: (next) => {
      held = next;
    },
    get: () => held ?? unwiredPort,
    wired: () => held !== undefined,
  };
}

/** Make a holder for the port; each computer-side folder that reads facts keeps one. */
export function createAgentFactsSlot(): FactsSlot<AgentFactsPort> {
  return slotOf(UNWIRED_AGENT_FACTS);
}

/** The package reads before a space side wires them: each rejects with {@link AGENT_FACTS_UNWIRED}. */
export const UNWIRED_PACKAGE_FACTS: PackageFactsPort = Object.freeze({
  packageSources: UNWIRED_AGENT_FACTS.packageSources,
  cachedPackageNames: UNWIRED_AGENT_FACTS.cachedPackageNames,
  projectInstalls: UNWIRED_AGENT_FACTS.projectInstalls,
  installDigest: UNWIRED_AGENT_FACTS.installDigest,
});

/** Make a holder for the package reads alone, for a folder (a harness) that needs only those. */
export function createPackageFactsSlot(): FactsSlot<PackageFactsPort> {
  return slotOf(UNWIRED_PACKAGE_FACTS);
}

// === A tool call's attribution, read once per session ===

/** What a DorkOS tool call learns about who is calling. */
export interface InSessionContext {
  /** The agent behind the session, when it resolved to one. */
  identity?: AgentIdentityFact;
  /** Set when the session's folder is some agent's that cannot be shown to be its own. */
  agentIdentityPresented?: boolean;
}

/**
 * Who the agent behind a session is, read once on first use and shared by
 * every tool call after it. A refused anchor presents an identity that is
 * nobody's, so a call is never decided as the operator's; no home is no
 * identity.
 *
 * @param anchor - The session's home resolution, or `undefined`.
 * @param describe - Who an agent is; may resolve `undefined` and must not reject.
 */
export function createInSessionContextResolver(
  anchor: HomeResolution | undefined,
  describe: (agentPath: string) => Promise<AgentIdentityFact | undefined>
): () => Promise<InSessionContext | undefined> {
  let pending: Promise<InSessionContext | undefined> | undefined;
  return () => {
    pending ??= (async () => {
      if (anchor?.kind === 'refused') return { agentIdentityPresented: true as const };
      const agentPath = anchor ? homeOf(anchor) : undefined;
      if (!agentPath) return undefined;
      const identity = await describe(agentPath);
      return identity ? { identity } : undefined;
    })();
    return pending;
  };
}
