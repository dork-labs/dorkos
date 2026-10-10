import {
  Doe,
  createCompaction,
  createBeatExtension,
  type Resources,
  type BeatRequest,
  type BeatResult,
} from '@dorkos/doe';
import type {
  AgentRuntime,
  AgentRegistryPort,
  ManagedMcpServerResolver,
  MessageOpts,
  SessionSettingsPort,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import { recordRuntimeToolCall, toolActorOf } from '../../audit/record-tool-use.js';
import {
  homeOf,
  resolveAgentHome,
  turnAgentOf,
  readHomeManifest,
} from '../../core/agent-identity/index.js';
import { agentRunsOnCredits } from '../../core/cloud/credits-model-gate.js';
import { creditsRefusalEvent } from '../../core/cloud/credits-protocols.js';
import { runtimeEnvironment } from '../shared/runtime-environment-config.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorTurnLeaseSupervisorHandle,
} from '../connectors/connector-turn-lease-supervisor.js';
import {
  connectorRuntimeHeaders,
  type ConnectorRuntimeTools,
  type ConnectorRuntimeMcpInjection,
} from '../connector-tools.js';
import { DOE_CAPABILITIES } from './runtime-constants.js';
import { DoeEventQueue } from './event-queue.js';
import { DoeApprovals } from './approvals.js';
import { DoeTurnEvents, doeErrorEvent } from './turn.js';
import { assembleDoeHost, type DoeHostAssembly } from './tools.js';
import { resolveDoeInference, freezeDoeInference } from './credentials.js';
import type { DoeRuntimeOptions } from './doe-runtime.js';
import type { DoeSessionStore } from './session-store.js';
export interface ActiveTurn {
  controller: AbortController;
  engine?: Doe;
  approvals: DoeApprovals;
  mode: string;
  extraContext: string[];
  done: Promise<void>;
  stopRequested: boolean;
  credits: boolean;
  settingsLoading: boolean;
}
export interface DoeTurnHostState {
  runtime: AgentRuntime;
  options: DoeRuntimeOptions;
  sessions: DoeSessionStore;
  settingsRevision: Map<string, number>;
  settingsPort?: SessionSettingsPort;
  mesh?: AgentRegistryPort;
  managedMcp?: ManagedMcpServerResolver;
  connectorTools?: ConnectorRuntimeTools;
  active: Map<string, ActiveTurn>;
  inference: () => DoeInferenceConfig | null;
  connected: (host: DoeHostAssembly) => void;
}
/** Execute one reserved turn; completion follows model, approval, MCP and bearer cleanup. */
export async function executeDoeTurn(
  hostState: DoeTurnHostState,
  input: {
    id: string;
    cwd: string;
    content?: string;
    opts?: MessageOpts;
    compact: boolean;
    beat?: {
      request: BeatRequest;
      settle: (result: BeatResult) => void;
    };
    turn: ActiveTurn;
    queue: DoeEventQueue<StreamEvent>;
    abortBeat: () => void;
  }
): Promise<void> {
  const { id, cwd, content, opts, compact, beat, turn, queue, abortBeat } = input;
  const controller = turn.controller;
  let host: DoeHostAssembly | undefined;
  let binding: Awaited<ReturnType<ConnectorRuntimeTools['principals']['openTurn']>> | undefined;
  let supervisor: ConnectorTurnLeaseSupervisorHandle | undefined;
  let mapper: DoeTurnEvents | undefined;
  let reason = 'completed';
  try {
    const revision = hostState.settingsRevision.get(id) ?? 0;
    let persisted = await hostState.settingsPort?.getSessionSettings(id);
    controller.signal.throwIfAborted();
    if (revision !== (hostState.settingsRevision.get(id) ?? 0))
      persisted = hostState.sessions.get(id)!.session;
    turn.settingsLoading = false;
    const modeChoice =
      opts?.permissionMode ??
      persisted?.permissionMode ??
      hostState.sessions.get(id)!.session.permissionMode ??
      'default';
    const mode =
      opts?.permissionCeiling === undefined
        ? modeChoice
        : clampModeToCeiling(DOE_CAPABILITIES.permissionModes, modeChoice, opts.permissionCeiling);
    turn.mode = mode;
    const record = hostState.sessions.get(id)!;
    const agentPath = homeOf(resolveAgentHome(cwd, turnAgentOf(opts)));
    if (!record.inference) {
      const config = hostState.inference();
      if (!config) throw new Error('Choose a model in DorkOS runtime settings.');
      const manifest = agentPath ? await readHomeManifest(agentPath) : null;
      const frozen = freezeDoeInference({
        config,
        creditsChosen:
          config.source === 'dorkos-credits' ||
          agentRunsOnCredits(
            hostState.runtime,
            { id: manifest?.id, account: manifest?.account },
            false
          ),
        model: opts?.model ?? persisted?.model ?? record.session.model,
      });
      record.inference = JSON.parse(JSON.stringify(frozen));
      hostState.sessions.setInference(id, record.inference!);
    }
    const config = DoeInferenceConfigSchema.parse(record.inference);
    turn.credits = config.source === 'dorkos-credits';
    const modelChoice = opts?.model ?? persisted?.model ?? record.session.model ?? config.model;
    const model = await (hostState.options.resolveModel ?? resolveDoeInference)({
      ...config,
      model: modelChoice,
    });
    controller.signal.throwIfAborted();
    // Catalog limits can differ from setup metadata; persist the actual turn budget.
    record.inference = {
      ...config,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    };
    hostState.sessions.setInference(id, record.inference!);
    mapper = new DoeTurnEvents(
      id,
      model,
      (event) => queue.push(event),
      compact ? 'manual' : 'auto',
      () => hostState.sessions.models.costTotal(id)
    );
    let helperActor: AuditActor | undefined;
    mapper.onHelperTool = (call) => {
      try {
        const actor = (helperActor ??= toolActorOf('doe', { ...(opts ?? {}), cwd }));
        if (!actor) return;
        recordRuntimeToolCall(
          {
            runtime: 'doe',
            sessionId: id,
            toolCallId: call.callId,
            name: call.name,
            input: call.input,
            actor,
            helperId: call.helper,
          },
          call.failed ? 'failed' : 'ok'
        );
      } catch {
        // Recording is never worth a turn.
      }
    };
    let connectorInjection: ConnectorRuntimeMcpInjection | null = null;
    if (agentPath && hostState.mesh?.getByPath(agentPath) && hostState.connectorTools) {
      binding = await hostState.connectorTools.principals.openTurn(
        {
          runtime: 'doe',
          canonicalSessionId: id,
          canonicalCwd: cwd,
          agentPath,
          signal: controller.signal,
        },
        { isCurrent: () => hostState.active.get(id) === turn }
      );
      supervisor = (
        hostState.connectorTools.createLeaseSupervisor ??
        ((options) => new ConnectorTurnLeaseSupervisor(options))
      )({
        principals: hostState.connectorTools.principals,
        bindingId: binding.bindingId,
        permit: binding.renewalPermit,
        runtime: 'doe',
        expiresAt: binding.expiresAt,
        signal: controller.signal,
        onLost: () => controller.abort(),
      });
      connectorInjection = {
        url: hostState.connectorTools.listenerUrl,
        agentToolsUrl: hostState.connectorTools.agentToolsUrl,
        headers: connectorRuntimeHeaders({
          bearer: binding.bearer,
          runtime: 'doe',
          canonicalCwd: cwd,
        }),
      };
    }
    host = await (hostState.options.assembleHost ?? assembleDoeHost)({
      sessionId: id,
      cwd,
      opts,
      signal: controller.signal,
      agentPath,
      managedMcp: hostState.managedMcp,
      webFetchPolicy: {
        allowUrl: (url) =>
          ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
      },
      connectorInjection,
      mesh: hostState.mesh,
      ...(mode === 'bypassPermissions'
        ? {
            builderExecutionPolicy: {
              kind: 'unrestricted',
              environment: runtimeEnvironment('doe', 'process-inspection'),
            } as const,
          }
        : {}),
      onEvent: mapper.receive,
      onChildStart: mapper.childStarted,
      onChildEnd: mapper.childEnded,
    });
    controller.signal.throwIfAborted();
    hostState.connected(host);
    const base = host.resources;
    const resources: Resources = {
      load: async () => [await base.load(), ...turn.extraContext].join('\n\n'),
      beforeFile: base.beforeFile.bind(base),
      skills: base.skills.bind(base),
      loadSkill: base.loadSkill.bind(base),
    };
    const extensions = {
      ...createCompaction({ reserveTokens: model.maxOutputTokens, retainTurns: 2 }),
      runBeat: createBeatExtension(),
    };
    turn.engine = new Doe(
      {
        sessionId: id,
        workingDirectory: cwd,
        model,
        store: hostState.sessions.models,
        resources,
        registry: host.registry,
        pathPolicy: host.pathPolicy,
        approve: turn.approvals.callback(
          mode,
          (event) => queue.push(event),
          controller.signal,
          opts?.unattended === true || opts?.unattendedApprovals === true,
          host.trustedHostToolNames
        ),
        onEvent: mapper.receive,
        extensions,
      },
      hostState.options.engineFactory
    );
    supervisor?.assertUsable();
    if (beat)
      beat.settle(await turn.engine.runBeat({ ...beat.request, signal: controller.signal }));
    else if (compact) await turn.engine.compact({ signal: controller.signal });
    else {
      hostState.sessions.message(id, content!, cwd, opts?.title);
      const result = await turn.engine.run(content!, { signal: controller.signal });
      if (result.stopReason === 'error') {
        const error = result.messages.at(-1)?.errorMessage;
        throw new Error(
          typeof error === 'string' ? error : 'The model could not finish this reply.'
        );
      }
      if (result.stopReason === 'aborted') reason = 'interrupted';
      else if (result.stopReason === 'length') reason = 'max_turns';
    }
  } catch (error) {
    if (controller.signal.aborted) reason = 'interrupted';
    else {
      reason = 'model_error';
      queue.push(creditsRefusalEvent(error) ?? doeErrorEvent(error));
    }
  } finally {
    turn.approvals.close();
    supervisor?.stop();
    try {
      await host?.dispose();
    } catch (error) {
      reason = 'model_error';
      queue.push(doeErrorEvent(error));
    }
    if (binding && hostState.connectorTools) {
      try {
        await hostState.connectorTools.principals.revoke(
          binding.bindingId,
          controller.signal.aborted
            ? 'turn_cancelled'
            : reason === 'completed'
              ? 'turn_terminal'
              : 'runtime_failed'
        );
      } catch (error) {
        reason = 'model_error';
        queue.push(doeErrorEvent(error));
      }
    }
    try {
      if (mapper) hostState.sessions.update(id, {});
    } catch (error) {
      reason = 'model_error';
      queue.push(doeErrorEvent(error));
    }
    try {
      mapper?.finish(reason, turn.stopRequested);
    } catch (error) {
      queue.push(doeErrorEvent(error));
    } finally {
      queue.push({ type: 'done', data: { sessionId: id } });
      queue.end();
      beat?.request.signal?.removeEventListener('abort', abortBeat);
      hostState.active.delete(id);
    }
  }
}
