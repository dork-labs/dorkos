/**
 * The values of the Connections lease that both sides of the server use: the
 * two refusals a runtime turn's setup or a DorkOS tool call can raise, and the
 * name of the tool that lists the services an agent can ask for.
 *
 * Plain values with no dependencies, so they live here: a runtime catches the
 * refusals the space side throws, and both name the tool, without either
 * importing the other. The lease's types, which hold live objects, are in the
 * server's kernel module `services/core/connections-lease/`.
 * Leaf module: it imports nothing.
 *
 * @module shared/connections-lease
 */

/** Typed setup refusal mapped by the runtime boundary without exposing private claims. */
export class ConnectorRuntimeAuthorityError extends Error {
  /**
   * Stable internal refusal code. `agent_unrecorded` is the one refusal a turn
   * may run on without connected apps: the chat has no recorded agent, so there
   * is nothing to grant (DOR-2752). Every other refusal fails the turn.
   */
  readonly code: 'boot_not_initialized' | 'authority_refused' | 'agent_unrecorded';

  /**
   * Construct a safe runtime authority error.
   *
   * @param code - Stable setup refusal category.
   * @param message - Secret-free diagnostic.
   */
  constructor(code: ConnectorRuntimeAuthorityError['code'], message: string) {
    super(message);
    this.name = 'ConnectorRuntimeAuthorityError';
    this.code = code;
  }
}

/** A native tool cannot proceed without its current server-owned turn context. */
export class RuntimeToolContextUnavailableError extends Error {
  readonly code = 'CALLER_CONTEXT_UNAVAILABLE';

  constructor() {
    super('Tools are unavailable for this message.');
    this.name = 'RuntimeToolContextUnavailableError';
  }
}

/**
 * The `dorkos` server tool that lists the services an agent can ask for.
 *
 * Request guidance and request refusals name it so an agent looks a service id
 * up instead of guessing one (DOR-2231). It is only callable where the `dorkos`
 * server itself was attached to the turn, so guidance names it only then.
 */
export const SERVICE_CATALOG_TOOL_NAME = 'connector_list_toolkits';
