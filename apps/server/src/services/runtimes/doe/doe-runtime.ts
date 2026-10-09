import {
  type EngineFactory,
  type ModelDescriptor,
  type BeatRequest,
  type BeatResult,
} from '@dorkos/doe';
import type {
  AgentRuntime,
  AgentRegistryPort,
  RelayPort,
  ManagedMcpServerResolver,
  MessageOpts,
  CommandIntentOpts,
  DependencyCheck,
  SessionUpdateResult,
  SessionSettingsPort,
  DeliverIntoTurnOpts,
  RuntimeDeliveryResult,
  ToolDecisionOptions,
  McpAppServerConnection,
  RuntimeCreditsProtocol,
} from '@dorkos/shared/agent-runtime';
import type {
  StreamEvent,
  ModelOption,
  CommandRegistry,
  InterruptReceipt,
  SessionSettings,
} from '@dorkos/shared/types';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { configManager } from '../../core/config-manager.js';
import { agentRunsOnCredits } from '../../core/cloud/credits-model-gate.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { DoeInferenceConfigSchema } from '@dorkos/shared/config-schema';
import { homeOf, resolveAgentHome, readHomeManifest } from '../../core/agent-identity/index.js';
import { peekProjector } from '../../session/session-state-projector.js';
import { dorkosToolsPosture } from '../shared/dorkos-mcp-injection.js';
import { type ConnectorRuntimeTools } from '../connector-tools.js';
import { executeDoeTurn, type ActiveTurn } from './execute-turn.js';
import { DoeSessionRuntime } from './session-runtime.js';
import { DOE_CAPABILITIES } from './runtime-constants.js';
import { canonicalDoeCwd } from './session-store.js';
import { DoeEventQueue } from './event-queue.js';
import { DoeApprovals } from './approvals.js';
import { type DoeHostOptions, type DoeHostAssembly } from './tools.js';
import { renderDoeContextEntry } from './context.js';
import { DOE_CREDITS_SUPPORT, inspectDoeInference } from './credentials.js';
import { listDoeModels } from './models.js';
/** Host injection permits real offline fixtures without replacing the adapter's session behavior. */
export interface DoeRuntimeOptions {
  directory?: string;
  defaultCwd?: string;
  inference?: () => DoeInferenceConfig | null;
  resolveModel?: (config: DoeInferenceConfig) => Promise<ModelDescriptor>;
  assembleHost?: (options: DoeHostOptions) => Promise<DoeHostAssembly>;
  engineFactory?: EngineFactory;
  interruptWaitMs?: number;
}
/** In-process business runtime with independent model records and durable app display events. */
export class DoeRuntime extends DoeSessionRuntime implements AgentRuntime {
  readonly type = 'doe';
  private readonly active = new Map<string, ActiveTurn>();
  private readonly status = new Map<string, McpServerEntry[]>();
  private readonly serverConfigs = new Map<string, ReadonlyMap<string, McpAppServerConnection>>();
  private mesh?: AgentRegistryPort;
  private relay?: RelayPort;
  private managedMcp?: ManagedMcpServerResolver;
  private connectorTools?: ConnectorRuntimeTools;
  private settingsPort?: SessionSettingsPort;
  private closing = false;
  private readonly settingsRevision = new Map<string, number>();
  private readonly capabilities = { ...DOE_CAPABILITIES, credits: DOE_CREDITS_SUPPORT };
  /** Construct local stores only; never resolve a key, launch a model or start another runtime. */
  constructor(private readonly options: DoeRuntimeOptions = {}) {
    super(options);
  }
  /** Persist first; permission changes to an active turn apply on its next turn. */
  async updateSession(id: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    const updated = this.sessions.update(id, opts);
    if (!updated) return { updated: false };
    this.settingsRevision.set(id, (this.settingsRevision.get(id) ?? 0) + 1);
    await this.settingsPort?.saveSessionSettings(id, opts);
    const live = this.active.get(id);
    const pending =
      live &&
      opts.permissionMode !== undefined &&
      (live.settingsLoading || live.mode !== opts.permissionMode);
    return { updated, ...(pending ? { permissionModePendingUntilNextTurn: true } : {}) };
  }
  /** Run one ordinary turn through the engine; the server owns display projection. */
  async *sendMessage(id: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    yield* this.runTurn(id, content, opts);
  }
  /** Compact the actual model store through the same single-flight and stream lifecycle. */
  async *executeCommandIntent(
    id: string,
    intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    if (intent !== 'compact') throw new Error('This command is unavailable.');
    yield* this.runTurn(id, undefined, opts, true);
  }
  private async *runTurn(
    id: string,
    content: string | undefined,
    opts?: MessageOpts,
    compact = false,
    beat?: {
      request: BeatRequest;
      settle: (result: BeatResult) => void;
    }
  ): AsyncGenerator<StreamEvent> {
    if (this.closing) throw new Error('The runtime is shutting down.');
    if (this.active.has(id)) throw new Error('This chat already has a running turn.');
    const existing = this.sessions.get(id);
    const cwd = canonicalDoeCwd(
      opts?.cwd ?? existing?.session.cwd ?? this.options.defaultCwd ?? DEFAULT_CWD
    );
    this.ensureSession(id, {
      ...opts,
      cwd,
      permissionMode: opts?.permissionMode ?? existing?.session.permissionMode ?? 'default',
    });
    const queue = new DoeEventQueue<StreamEvent>();
    const controller = new AbortController();
    const turn: ActiveTurn = {
      controller,
      mode: 'default',
      credits: false,
      settingsLoading: true,
      approvals: new DoeApprovals(),
      extraContext: [],
      done: Promise.resolve(),
      stopRequested: false,
    };
    this.active.set(id, turn);
    const abortBeat = () => controller.abort(beat?.request.signal?.reason);
    beat?.request.signal?.addEventListener('abort', abortBeat, { once: true });
    if (beat?.request.signal?.aborted) abortBeat();
    turn.done = executeDoeTurn(
      {
        runtime: this,
        options: this.options,
        sessions: this.sessions,
        settingsRevision: this.settingsRevision,
        settingsPort: this.settingsPort,
        mesh: this.mesh,
        relay: this.relay,
        managedMcp: this.managedMcp,
        connectorTools: this.connectorTools,
        active: this.active,
        inference: () => this.inference(),
        connected: (host) => {
          this.status.set(cwd, [...host.mcpStatus]);
          this.serverConfigs.set(cwd, new Map(Object.entries(host.mcpServerConfigs)));
        },
      },
      { id, cwd, content, opts, compact, beat, turn, queue, abortBeat }
    );
    try {
      for await (const event of queue) yield event;
    } finally {
      if (this.active.get(id) === turn) {
        controller.abort();
        turn.engine?.abort();
        turn.approvals.close();
      }
      await this.waitTurn(turn);
    }
  }
  /** Run the isolated engine Beat; the caller decides how structured raises are delivered. */
  async runBeat(id: string, request: BeatRequest, opts?: MessageOpts): Promise<BeatResult> {
    let result: BeatResult | undefined;
    let failure: string | undefined;
    for await (const event of this.runTurn(id, undefined, opts, false, {
      request,
      settle: (outcome) => {
        result = outcome;
      },
    })) {
      if (event.type === 'error')
        failure = (
          event.data as {
            message: string;
          }
        ).message;
    }
    if (!result) throw new Error(failure ?? 'The beat did not finish.');
    return result;
  }
  private inference(): DoeInferenceConfig | null {
    return this.options.inference
      ? this.options.inference()
      : configManager.get('runtimes').doe.inference;
  }
  private async waitTurn(turn: ActiveTurn): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        turn.done.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.options.interruptWaitMs ?? 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Accept an approval only when this turn still holds its exact request. */
  approveTool(id: string, toolId: string, approved: boolean, opts?: ToolDecisionOptions): boolean {
    const answered = this.active.get(id)?.approvals.approve(toolId, approved, opts) ?? false;
    if (answered)
      peekProjector(id)?.resolveInteraction(toolId, approved ? 'approved' : 'denied', {
        ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
      });
    return answered;
  }
  /** Structured questions are not advertised by this engine host. */
  submitAnswers(): boolean {
    return false;
  }
  /** The current engine MCP client does not advertise elicitation support. */
  submitElicitation(): boolean {
    return false;
  }
  /** No detached task survives an owned turn; unknown task ids are not running. */
  async stopTask(): Promise<InterruptReceipt> {
    return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
  }
  /** Abort and observe owned cleanup; a deadline without completion is explicitly unconfirmed. */
  async interruptQuery(id: string): Promise<InterruptReceipt> {
    const turn = this.active.get(id);
    if (!turn) return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
    turn.stopRequested = true;
    turn.controller.abort();
    turn.engine?.abort();
    turn.approvals.close();
    return (await this.waitTurn(turn))
      ? { outcome: 'acked', runtime: this.type }
      : { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: this.type };
  }
  /** Steering keeps the person's words pristine and context on the system channel. */
  async deliverIntoTurn(
    id: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult> {
    if (opts.mode !== 'steer') return { delivered: false, reason: 'unsupported' };
    const turn = this.active.get(id);
    if (!turn) return { delivered: false, reason: 'no-open-turn' };
    if (!turn.engine || turn.controller.signal.aborted)
      return { delivered: false, reason: 'stream-closed' };
    const context = (opts.additionalContext ?? []).map(renderDoeContextEntry).join('\n\n');
    if (context) turn.extraContext.push(context);
    const delivered = turn.engine.steer(content) === 'queued';
    if (!delivered && context) turn.extraContext.pop();
    return delivered ? { delivered } : { delivered, reason: 'stream-closed' };
  }
  /** The adapter's owned live slot is authoritative even before model setup finishes. */
  isTurnOpen(id: string): boolean {
    return this.active.has(id);
  }
  /** Model discovery is pure configuration metadata, with no ambient auth or sidecar. */
  async getSupportedModels(sessionId?: string): Promise<ModelOption[]> {
    const frozen = sessionId ? this.sessions.get(sessionId)?.inference : undefined;
    return listDoeModels(frozen ? DoeInferenceConfigSchema.parse(frozen) : this.inference());
  }
  /** The engine's builder is a tool, not a vendor-named subagent preset. */
  async getSupportedSubagents(): Promise<[]> {
    return [];
  }
  /** Return stable declarations shared by every runtime instance. */
  getCapabilities() {
    return this.capabilities;
  }
  /** Honest settings readiness without performing a paid authentication probe. */
  async checkDependencies(): Promise<DependencyCheck[]> {
    const configured = inspectDoeInference(this.inference()).configured;
    return [
      { name: 'DorkOS engine', description: 'Included with DorkOS.', status: 'satisfied' },
      {
        name: 'Model authentication',
        description: 'Choose a model and inference source.',
        status: configured ? 'satisfied' : 'missing',
        installHint: 'Open DorkOS runtime settings.',
      },
    ];
  }
  /** Expose only a non-secret source label. */
  getConnectedProvider(): string | null {
    return this.inference()?.provider ?? null;
  }
  /** Command intent discovery is handled by the platform rather than vendor slash commands. */
  async getCommands(): Promise<CommandRegistry> {
    return { commands: [], lastScanned: new Date().toISOString() };
  }
  /** Turns own their cleanup; idle metadata does not expire out of session listing. */
  checkSessionHealth(): void {}
  /** Doe's canonical id is already the DorkOS id; no rekey exists. */
  getInternalSessionId(): undefined {
    return undefined;
  }
  /** Install peer/identity lookups without exposing SDK types. */
  setMeshCore(mesh: AgentRegistryPort): void {
    this.mesh = mesh;
  }
  /** Install the existing relay availability port. */
  setRelay(relay: RelayPort): void {
    this.relay = relay;
  }
  /** Managed server configuration is read afresh for each turn. */
  setManagedMcpServerResolver(resolver: ManagedMcpServerResolver): void {
    this.managedMcp = resolver;
  }
  /** Install the server-owned authenticated turn boundary after boot. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void {
    this.connectorTools = tools;
  }
  /** Share durable mutable session choices with the platform routes. */
  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }
  /** Report actual last-known MCP connectivity, never a guessed connected state. */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.status.get(canonicalDoeCwd(cwd)) ?? null;
  }
  /** Server-only resolved foreign MCP transport; callers retain normal credential masking. */
  getMcpServerConfig(cwd: string, name: string): McpAppServerConnection | null {
    return this.serverConfigs.get(canonicalDoeCwd(cwd))?.get(name) ?? null;
  }
  /** Use the same agent-home check and installed listener facts as turn injection. */
  async carriesRoomTools(session: {
    cwd: string;
    sessionId: string;
    agentPath?: string;
  }): Promise<boolean> {
    const home = homeOf(resolveAgentHome(session.cwd, session.agentPath));
    return (
      home !== undefined &&
      this.mesh?.getByPath(home) !== undefined &&
      dorkosToolsPosture(home, this.connectorTools !== undefined).wired
    );
  }
  /** Format discovery reads frozen session metadata, never credentials or a model request. */
  getCreditsProtocol(id?: string): RuntimeCreditsProtocol | undefined {
    const frozen = id ? this.sessions.get(id)?.inference : undefined;
    return frozen ? DoeInferenceConfigSchema.parse(frozen).protocol : this.inference()?.protocol;
  }

  /** The model gate reads the same frozen payer the next turn will use. */
  async sessionRunsOnCredits(id: string): Promise<boolean> {
    const record = this.sessions.get(id);
    if (record?.inference)
      return DoeInferenceConfigSchema.parse(record.inference).source === 'dorkos-credits';
    const config = this.inference();
    if (!config) return false;
    if (config.source === 'dorkos-credits') return true;
    const bound = await runtimeRegistry.getSessionAgentPath(id).catch(() => null);
    const home = homeOf(
      resolveAgentHome(
        record?.session.cwd ?? this.options.defaultCwd ?? DEFAULT_CWD,
        bound ?? undefined
      )
    );
    const manifest = home ? await readHomeManifest(home) : null;
    return agentRunsOnCredits(this, { id: manifest?.id, account: manifest?.account }, false);
  }

  /** An unlink cancels only turns whose frozen payer is DorkOS credits. */
  stopCreditsTurns(): void {
    for (const turn of this.active.values())
      if (turn.credits) {
        turn.controller.abort();
        turn.engine?.abort();
        turn.approvals.close();
      }
  }
  /** Stop owned turns before closing SQLite; an unconfirmed owner keeps its storage intact. */
  async shutdown(): Promise<void> {
    this.closing = true;
    const receipts = await Promise.all(
      [...this.active.keys()].map((id) => this.interruptQuery(id))
    );
    if (receipts.some((receipt) => receipt.outcome === 'unconfirmed'))
      throw new Error('A DorkOS turn has not stopped.');
    this.sessions.close();
  }
}
