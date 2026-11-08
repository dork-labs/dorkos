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
 * **The swap waits for the in-process servers,** on a short bound, since the CLI
 * stops reading their connect answers while it handles one.
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
import {
  awaitControlAck,
  IN_PROCESS_CONNECT_BOUND_MS,
  PLUGIN_RELOAD_ACK_TIMEOUT_MS,
  requestWithinBound,
} from '../sessions/bounded-control.js';

/** How often to ask whether the in-process servers have connected. */
const IN_PROCESS_POLL_MS = 25;

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
 * Whether a server really runs in this process. The SDK treats `type: 'sdk'` with
 * no usable `instance` as an ordinary server and writes it to `--mcp-config`, and
 * a repo's `.mcp.json` could write one. JSON cannot forge a function.
 */
function isInProcess(config: McpServerConfig): boolean {
  if (config.type !== 'sdk') return false;
  const instance = (config as { instance?: { connect?: unknown } | null }).instance;
  return typeof instance?.connect === 'function';
}

/**
 * The servers a launch may name on the command line: in-process ones only, each
 * kept whole, since `dorkos`'s tool timeout rides its entry.
 *
 * @param servers - Every server this launch wants.
 * @returns The in-process servers, or `undefined` when there are none.
 */
export function commandLineServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined
): Record<string, McpServerConfig> | undefined {
  const kept = Object.entries(servers ?? {}).filter(([, config]) => isInProcess(config));
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
 * Wait, within a bound, for the in-process servers to report connected. The CLI
 * handles a server swap in order and stops reading their connect answers while it
 * waits, so a swap sent sooner lets a hung external server fail them too. A status
 * read that fails or says `failed` ends the wait: more of it would not help.
 */
async function whenInProcessConnected(live: Query, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const deadline = Date.now() + IN_PROCESS_CONNECT_BOUND_MS;
  while (Date.now() < deadline) {
    const statuses = await requestWithinBound(
      () => live.mcpServerStatus(),
      deadline - Date.now(),
      'mcpServerStatus'
    ).catch(() => undefined);
    const settled = names.every((name) => {
      const status = statuses?.find((s) => s.name === name)?.status;
      return status === 'connected' || status === 'failed';
    });
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, IN_PROCESS_POLL_MS));
  }
  logger.warn('[launch-query] in-process MCP servers did not report in time');
}

/**
 * Start a process, with its external servers handed over stdin.
 *
 * @param input - See {@link LaunchQueryInput}.
 * @returns The live query, already running.
 */
export function launchQuery(input: LaunchQueryInput): Query {
  const { prompt, options, session, afterServers, onServersNotHeld } = input;
  const inProcess = commandLineServers(options.mcpServers);
  // A `type: 'sdk'` entry with no real instance is nobody's server: it goes nowhere.
  const handover = Object.fromEntries(
    Object.entries(options.mcpServers ?? {}).filter(
      ([, config]) => config.type !== 'sdk' || isInProcess(config)
    )
  );
  const { mcpServers: _everyServer, ...rest } = options;
  const launchOptions = inProcess ? { ...rest, mcpServers: inProcess } : rest;
  if (Object.keys(handover).length === Object.keys(inProcess ?? {}).length) {
    const live = query({ prompt, options: launchOptions });
    afterServers?.(live);
    return live;
  }
  let openGate = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const live = query({ prompt: afterGate(gate, prompt), options: launchOptions });
  void whenInProcessConnected(live, Object.keys(inProcess ?? {}))
    .then(() => awaitControlAck(() => live.setMcpServers(handover), PLUGIN_RELOAD_ACK_TIMEOUT_MS))
    .then((ack) => {
      if (ack !== 'acked') {
        logger.warn('[launch-query] a new process did not answer for its MCP servers', { ack });
        noteServersStarting(session);
        onServersNotHeld?.(live);
      }
      openGate();
      afterServers?.(live);
    });
  return live;
}
