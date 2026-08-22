/**
 * The probes a launch fires at the subprocess it just started: what models it
 * offers, which MCP servers came up, which slash commands and subagents it
 * knows (spec `persistent-session-runtime` §P3, task 3.10).
 *
 * ## Why this is per PROCESS and not per turn
 *
 * Every one of these answers describes the SUBPROCESS, not the message that
 * happened to boot it, and none of them is awaited — the turn streams while they
 * settle in the background. On the resume-per-message path a process and a turn
 * were the same thing, so "fires on every query" and "fires on every turn" were
 * indistinguishable and the block lived inline in `executeSdkQuery`.
 *
 * A pump makes them different, and the difference is a bug waiting to happen: a
 * pump path that did not fire these would leave the model cache, the MCP status
 * snapshot, the command palette and the subagent list unpopulated for the whole
 * life of a warm session — a cockpit quietly missing four things, on the path
 * that is supposed to be indistinguishable from the other one. So the block
 * moved here and BOTH launchers call it.
 *
 * @module services/runtimes/claude-code/messaging/launch-probes
 */
import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../../lib/logger.js';
import { LAUNCH_PROBE_ACK_TIMEOUT_MS, requestWithinBound } from '../sessions/bounded-control.js';
import { toMcpAppConnection, type MessageSenderOpts } from './message-sender-shared.js';

/** The slice of the SDK `Query` these probes use. */
type ProbeQuery = Pick<
  Query,
  'supportedModels' | 'mcpServerStatus' | 'supportedCommands' | 'supportedAgents'
>;

/**
 * Ask a freshly launched subprocess what it supports, and hand each answer to
 * the runtime cache. Never awaited and never throws: a probe that fails costs
 * the cache one refresh, never the turn.
 *
 * Not being awaited is not the same as being free (DOR-1301). A probe sent to a
 * subprocess that can no longer hear DorkOS is dropped in silence against a
 * promise nothing will settle, and since nobody is waiting, nobody notices: the
 * promise, its query and its closures simply stay alive for as long as the
 * server does, once per probe per launch. Each one is bounded for that reason
 * alone — the bound cannot rescue an answer nobody is waiting for, it just lets
 * the wait end.
 *
 * @param agentQuery - The live query just returned by `query()`
 * @param opts - The runtime's cache callbacks
 */
export function fireLaunchProbes(agentQuery: ProbeQuery, opts: MessageSenderOpts): void {
  // Non-blocking model fetch on first invocation
  if (opts.onModelsReceived) {
    requestWithinBound(
      () => agentQuery.supportedModels(),
      LAUNCH_PROBE_ACK_TIMEOUT_MS,
      'supportedModels'
    )
      // Whole objects, never a field pick — see the SdkReportedModel doc for
      // the capability-starvation incident a pick here caused.
      .then((models) => {
        opts.onModelsReceived!(models);
      })
      .catch((err) => {
        logger.debug('[launch-probes] failed to fetch supported models', { err });
      });
  }

  // Non-blocking MCP status snapshot — fires every query, overwrites cache
  if (opts.onMcpStatusReceived || opts.onMcpServerConfigsReceived) {
    requestWithinBound(
      () => agentQuery.mcpServerStatus(),
      LAUNCH_PROBE_ACK_TIMEOUT_MS,
      'mcpServerStatus'
    )
      .then((statuses) => {
        const external = statuses.filter((s) => s.name !== 'dorkos');
        opts.onMcpStatusReceived?.(
          external.map((s) => ({
            name: s.name,
            type:
              s.config?.type === 'sse' || s.config?.type === 'http'
                ? s.config.type
                : ('stdio' as const),
            status: s.status,
            error: s.error,
            scope: s.scope,
          }))
        );
        // Capture resolved connection config server-side for MCP App resource
        // reads (ADR 260708-141143). Kept separate from the client-facing entry.
        if (opts.onMcpServerConfigsReceived) {
          const captured: Array<{ name: string; connection: McpAppServerConnection }> = [];
          for (const s of external) {
            const connection = toMcpAppConnection(s.config);
            if (connection) captured.push({ name: s.name, connection });
          }
          opts.onMcpServerConfigsReceived(captured);
        }
      })
      .catch((err) => {
        logger.debug('[launch-probes] failed to fetch MCP server status', { err });
      });
  }

  // Non-blocking command discovery — fires on first query, caches on runtime
  if (opts.onCommandsReceived) {
    requestWithinBound(
      () => agentQuery.supportedCommands(),
      LAUNCH_PROBE_ACK_TIMEOUT_MS,
      'supportedCommands'
    )
      .then((commands) => {
        opts.onCommandsReceived!(
          commands.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            aliases: c.aliases,
          }))
        );
      })
      .catch((err) => {
        logger.debug('[launch-probes] failed to fetch supported commands', { err });
      });
  }

  // Non-blocking subagent discovery — fires on first query, caches on runtime
  if (opts.onSubagentsReceived && agentQuery.supportedAgents) {
    const supportedAgents = agentQuery.supportedAgents.bind(agentQuery);
    requestWithinBound(() => supportedAgents(), LAUNCH_PROBE_ACK_TIMEOUT_MS, 'supportedAgents')
      .then((agents) => {
        opts.onSubagentsReceived!(
          agents.map((a) => ({
            name: a.name,
            description: a.description,
            model: a.model,
          }))
        );
      })
      .catch((err) => {
        logger.debug('[launch-probes] failed to fetch supported agents', { err });
      });
  }
}
