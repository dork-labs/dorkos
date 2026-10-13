/**
 * Open a turn's connected apps, or let the turn run without them.
 *
 * A runtime that opens its connected-apps binding before the turn starts
 * (Codex, Doe, OpenCode) used to fail the whole turn when the chat had no
 * recorded agent — a chat started in an agent's folder without naming the
 * agent (DOR-2752). Retrying never helped. Running that turn without connected
 * apps is the honest outcome: there is no agent to grant them to, and the chat
 * still answers. Every other refusal still fails the turn.
 *
 * @module services/runtimes/connectors/open-connector-turn
 */
import { logger } from '../../../lib/logger.js';
import { ConnectorRuntimeAuthorityError } from '../../connectors/principal/runtime-principal-service.js';
import type {
  ConnectorRuntime,
  ConnectorRuntimePrincipalPort,
  ConnectorTurnOwnership,
  OpenConnectorTurnInput,
  OpenConnectorTurnResult,
} from '../../connectors/runtime-principal-port.js';
import {
  connectorRuntimeHeaders,
  type ConnectorRuntimeMcpInjection,
  type ConnectorRuntimeTools,
} from '../connector-tools.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorLeaseLoss,
  type ConnectorTurnLeaseSupervisorHandle,
} from './connector-turn-lease-supervisor.js';

/** What one turn asks for when it opens its connected apps. */
export interface OpenConnectorTurnRequest {
  /** The runtime running the turn. */
  runtime: ConnectorRuntime;
  /** The canonical DorkOS session id. */
  sessionId: string;
  /** The agent directory the turn claims to run as. */
  agentPath: string;
  /** The turn's canonical working directory. */
  cwd: string;
  /** Aborts when the turn is cancelled. */
  signal: AbortSignal;
  /** Whether this turn is still the session's current one. */
  isCurrent: () => boolean;
  /** Called when the binding's lease is lost mid-turn. */
  onLost: (loss: ConnectorLeaseLoss) => void;
}

/** An opened binding, its lease supervisor, and the MCP injection it grants. */
export interface OpenedConnectorTurn {
  /** The binding, revoked by the runtime when the turn ends. */
  binding: OpenConnectorTurnResult;
  /** Keeps the binding's lease alive; stopped when the turn ends. */
  supervisor: ConnectorTurnLeaseSupervisorHandle;
  /** The connector-only MCP server the turn's model reaches. */
  injection: ConnectorRuntimeMcpInjection;
}

/**
 * Open the binding, or return `null` when the chat has no recorded agent.
 * Any other refusal or failure, a cancelled turn, or a turn a newer one
 * replaced still throws, exactly as before.
 *
 * @param principals - The runtime principal port.
 * @param input - The turn's binding request.
 * @param ownership - Whether this turn is still the session's current one.
 */
export async function openTurnOrSkip(
  principals: Pick<ConnectorRuntimePrincipalPort, 'openTurn'>,
  input: OpenConnectorTurnInput,
  ownership: ConnectorTurnOwnership
): Promise<OpenConnectorTurnResult | null> {
  try {
    return await principals.openTurn(input, ownership);
  } catch (err) {
    input.signal.throwIfAborted();
    const unrecorded =
      err instanceof ConnectorRuntimeAuthorityError && err.code === 'agent_unrecorded';
    if (!unrecorded || !ownership.isCurrent()) throw err;
    logger.warn('[connectors] chat has no recorded agent; this turn runs without connected apps', {
      runtime: input.runtime,
      sessionId: input.canonicalSessionId,
    });
    return null;
  }
}

/**
 * Start the lease supervisor that keeps an opened binding alive for its turn.
 *
 * @param tools - The server's connector runtime tools.
 * @param binding - The binding {@link openTurnOrSkip} opened.
 * @param request - The turn's runtime, signal and lease-lost handler.
 */
export function startConnectorLease(
  tools: ConnectorRuntimeTools,
  binding: OpenConnectorTurnResult,
  request: Pick<OpenConnectorTurnRequest, 'runtime' | 'signal' | 'onLost'>
): ConnectorTurnLeaseSupervisorHandle {
  const createSupervisor =
    tools.createLeaseSupervisor ?? ((options) => new ConnectorTurnLeaseSupervisor(options));
  return createSupervisor({
    principals: tools.principals,
    bindingId: binding.bindingId,
    permit: binding.renewalPermit,
    runtime: request.runtime,
    expiresAt: binding.expiresAt,
    signal: request.signal,
    onLost: request.onLost,
  });
}

/**
 * Open the binding, its lease and its MCP injection, or return `null` when the
 * chat has no recorded agent ({@link openTurnOrSkip}).
 *
 * @param tools - The server's connector runtime tools.
 * @param request - The turn's binding request.
 */
export async function openConnectorTurn(
  tools: ConnectorRuntimeTools,
  request: OpenConnectorTurnRequest
): Promise<OpenedConnectorTurn | null> {
  const { runtime, sessionId, agentPath, cwd, signal, isCurrent, onLost } = request;
  const binding = await openTurnOrSkip(
    tools.principals,
    { runtime, canonicalSessionId: sessionId, agentPath, canonicalCwd: cwd, signal },
    { isCurrent }
  );
  if (!binding) return null;
  try {
    const supervisor = startConnectorLease(tools, binding, request);
    const injection: ConnectorRuntimeMcpInjection = {
      url: tools.listenerUrl,
      agentToolsUrl: tools.agentToolsUrl,
      headers: connectorRuntimeHeaders({ bearer: binding.bearer, runtime, canonicalCwd: cwd }),
    };
    return { binding, supervisor, injection };
  } catch (err) {
    // The runtime never saw this binding, so it cannot revoke it.
    try {
      await tools.principals.revoke(binding.bindingId, 'setup_failed');
    } catch {
      // The binding's own expiry still ends it.
    }
    throw err;
  }
}
