/**
 * The global MCP servers slice of the {@link Transport} port (DOR-3213): the servers a person adds
 * once for every agent, in Connections → MCP servers.
 *
 * A change that needs "Confirm it's you" waits on the sheet inside the call and answers with what
 * the change itself answered. A cancel rejects with `code: 'step_up_required'`, having changed
 * nothing.
 *
 * @module shared/transport-global-mcp
 */
import type {
  GlobalMcpArgsCheckResult,
  GlobalMcpServerInput,
  GlobalMcpServerList,
  GlobalMcpServerPatch,
  GlobalMcpServerView,
  GlobalMcpStandingAllowList,
  GlobalMcpToolsCheck,
} from './global-mcp-schemas.js';

/** The global MCP server methods every Transport implements. */
export interface GlobalMcpTransport {
  /** Every global server, secrets by name only. */
  listGlobalMcpServers(): Promise<GlobalMcpServerList>;

  /**
   * Whether typed arguments look like they hold a secret. It warns and never refuses.
   *
   * @param args - The arguments as a person typed them.
   */
  checkGlobalMcpArgs(args: readonly string[]): Promise<GlobalMcpArgsCheckResult>;

  /**
   * Add a server for every agent.
   *
   * @param input - What it runs, its secrets as a person typed them, and who gets it.
   */
  addGlobalMcpServer(input: GlobalMcpServerInput): Promise<GlobalMcpServerView>;

  /**
   * Turn a server on or off, or change which agents it skips.
   *
   * @param name - The server.
   * @param patch - The switches to change.
   */
  patchGlobalMcpServer(name: string, patch: GlobalMcpServerPatch): Promise<GlobalMcpServerView>;

  /**
   * Remove a server and its saved secrets. Rejects with `code: 'secret_left'` when the server is
   * gone but a saved secret was not deleted.
   *
   * @param name - The server.
   */
  removeGlobalMcpServer(name: string): Promise<void>;

  /**
   * Check a server's tools now, for its sheet (DOR-4118). Starts the server only when it is on and
   * approved; otherwise answers `not-checked`. Names and descriptions are the server's own text.
   *
   * @param name - The server.
   */
  checkGlobalMcpServerTools(name: string): Promise<GlobalMcpToolsCheck>;

  /**
   * The agents whose folders let them use a server, or one tool on it, without asking.
   *
   * @param name - The server.
   */
  listGlobalMcpStandingAllows(name: string): Promise<GlobalMcpStandingAllowList>;

  /**
   * Remove one standing yes from an agent's own settings file. Owner at this computer only.
   *
   * @param name - The server.
   * @param agentId - The agent, as the registry knows it.
   * @param rule - The exact rule to remove.
   */
  undoGlobalMcpStandingAllow(name: string, agentId: string, rule: string): Promise<void>;
}
