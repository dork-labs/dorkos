/**
 * Open a turn's connected apps, or let the turn run without them.
 *
 * A runtime that opens its connected-apps binding before the turn starts
 * (Codex, Doe) used to fail the whole turn when DorkOS could not confirm which
 * agent the chat belongs to — a chat started in an agent's folder with no
 * recorded agent, for example (DOR-2752). Retrying never helped. Running the
 * turn without connected apps is the honest outcome: nothing is granted that
 * could not be proved, and the chat still answers.
 *
 * @module services/runtimes/connectors/open-connector-turn
 */
import { logger } from '../../../lib/logger.js';
import { ConnectorRuntimeAuthorityError } from '../../connectors/principal/runtime-principal-service.js';
import type {
  ConnectorRuntime,
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
 * Open the binding and its lease, or return `null` when this chat's agent
 * could not be confirmed. Any other failure, a cancelled turn, or a turn a
 * newer one replaced still throws, exactly as before.
 *
 * @param tools - The server's connector runtime tools.
 * @param request - The turn's binding request.
 */
export async function openConnectorTurn(
  tools: ConnectorRuntimeTools,
  request: OpenConnectorTurnRequest
): Promise<OpenedConnectorTurn | null> {
  const { runtime, sessionId, agentPath, cwd, signal, isCurrent, onLost } = request;
  let binding: OpenConnectorTurnResult;
  try {
    binding = await tools.principals.openTurn(
      { runtime, canonicalSessionId: sessionId, agentPath, canonicalCwd: cwd, signal },
      { isCurrent }
    );
  } catch (err) {
    signal.throwIfAborted();
    const refused =
      err instanceof ConnectorRuntimeAuthorityError && err.code === 'authority_refused';
    if (!refused || !isCurrent()) throw err;
    logger.warn('[connectors] agent not confirmed; this turn runs without connected apps', {
      runtime,
      sessionId,
    });
    return null;
  }
  try {
    const createSupervisor =
      tools.createLeaseSupervisor ?? ((options) => new ConnectorTurnLeaseSupervisor(options));
    const supervisor = createSupervisor({
      principals: tools.principals,
      bindingId: binding.bindingId,
      permit: binding.renewalPermit,
      runtime,
      expiresAt: binding.expiresAt,
      signal,
      onLost,
    });
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
