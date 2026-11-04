/**
 * Start a Claude Code process with its MCP servers off the command line
 * (DOR-3882).
 *
 * The SDK turns `options.mcpServers` into `--mcp-config <json>`, so a stdio
 * server's env, an http server's headers and a sign-in's bearer would all sit in
 * the process's arguments, readable by anything that can list processes. So a
 * launch passes only the in-process (`sdk`) servers, which carry no secret, and
 * hands the rest over stdin with `setMcpServers` before the first message goes.
 *
 * **The first message waits.** The CLI answers `setMcpServers` once the servers
 * are connected, so holding the input stream until then makes their tools ready
 * on the first turn. The wait is bounded by {@link PLUGIN_RELOAD_ACK_TIMEOUT_MS},
 * the budget every other live setter spends between send and the turn opening.
 *
 * **Past the bound it fails closed.** The servers are never put back on the
 * command line. The turn opens, the chat says some tools may not work yet, and
 * the caller records what the process holds as unknown, so the next dispatch
 * asks again. Slow or refused both take this path.
 *
 * **What this does not do.** It fixes the CLI's command line only. A stdio
 * server's own environment stays readable by programs running as the same user,
 * and its own arguments stay on its own command line, readable by every account
 * on the computer. So a secret belongs in a setting, not an argument, and keeping
 * an agent from a server does not keep a stdio secret from that agent's shell
 * (DOR-505).
 *
 * @module services/runtimes/claude-code/sdk/launch-query
 */
import {
  query,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import { awaitControlAck, PLUGIN_RELOAD_ACK_TIMEOUT_MS } from '../sessions/bounded-control.js';

/** What the chat says when servers were not ready in time. */
export const SERVERS_STARTING_STATUS =
  'Some tool servers are still starting. Their tools may not work this turn.';

/** The part of a session a notice is delivered through. */
export interface NoticeSession {
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

/** One launch. */
export interface LaunchQueryInput {
  /** The held input stream. Nothing is read from it until the servers answered. */
  prompt: AsyncIterable<SDKUserMessage>;
  /** The resolved options, every server included. */
  options: Options;
  /** Told the chat's notice goes here. */
  session: NoticeSession;
  /**
   * Run once the servers answered or the bound expired, or at once with none to
   * hand over: a status probe sent sooner would miss them.
   */
  afterServers?: (live: Query) => void;
  /** Told when the process does not hold its servers, so the caller can record that. */
  onServersNotHeld?: (live: Query) => void;
}

/**
 * The servers a launch may name on the command line: in-process ones only, and
 * only what makes them so. The SDK treats `type: 'sdk'` with no `instance` as an
 * ordinary server and writes it to `--mcp-config`, and a repo's `.mcp.json` can
 * supply one, so the type alone is not enough and no other field goes along.
 *
 * @param servers - Every server this launch wants.
 * @returns The in-process servers, or `undefined` when there are none.
 */
export function commandLineServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined
): Record<string, McpServerConfig> | undefined {
  const kept = Object.entries(servers ?? {}).flatMap(([key, config]) =>
    config.type === 'sdk' && 'instance' in config
      ? [[key, { type: config.type, name: config.name, instance: config.instance }] as const]
      : []
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Say in the chat that some tools may not be ready this turn.
 *
 * @param session - The session whose turn is opening.
 */
export function noteServersStarting(session: NoticeSession): void {
  session.eventQueue.push({ type: 'system_status', data: { message: SERVERS_STARTING_STATUS } });
  session.eventQueueNotify?.();
}

/** The input stream, once `gate` opens. Ending or abandoning it passes straight through. */
async function* afterGate(
  gate: Promise<void>,
  prompt: AsyncIterable<SDKUserMessage>
): AsyncGenerator<SDKUserMessage> {
  await gate;
  yield* prompt;
}

/**
 * Start a process, with its external servers handed over stdin.
 *
 * @param input - See {@link LaunchQueryInput}.
 * @returns The live query, already running.
 */
export function launchQuery(input: LaunchQueryInput): Query {
  const { prompt, options, session, afterServers, onServersNotHeld } = input;
  const servers = options.mcpServers;
  const inProcess = commandLineServers(servers);
  const external = Object.keys(servers ?? {}).length > Object.keys(inProcess ?? {}).length;
  if (!servers || !external) {
    const live = query({ prompt, options });
    afterServers?.(live);
    return live;
  }
  let openGate = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const { mcpServers: _everyServer, ...rest } = options;
  const live = query({
    prompt: afterGate(gate, prompt),
    options: inProcess ? { ...rest, mcpServers: inProcess } : rest,
  });
  void awaitControlAck(() => live.setMcpServers(servers), PLUGIN_RELOAD_ACK_TIMEOUT_MS).then(
    (ack) => {
      if (ack !== 'acked') {
        logger.warn('[launch-query] a new process did not answer for its MCP servers', { ack });
        noteServersStarting(session);
        onServersNotHeld?.(live);
      }
      openGate();
      afterServers?.(live);
    }
  );
  return live;
}
