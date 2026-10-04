/**
 * Giving the person's agents tools from an extension's server half
 * (`ctx.tools`, DOR-2685).
 *
 * Declare each tool in `extension.json` under `tools`, then bind its handler
 * in `register()` with `ctx.tools.handle(name, handler)`. DorkOS offers the
 * tools to agents once `register()` finishes, and takes them away when the
 * extension stops, reloads or is turned off.
 *
 * Plain types with no runtime dependencies, so an extension bundle can import
 * them.
 *
 * @module @dorkos/extension-api/extension-tools
 */

/** `ctx.tools`: bind the handlers for the tools `extension.json` declares. */
export interface ToolsApi {
  /**
   * Bind the handler for one declared tool. Call it while `register()` runs;
   * DorkOS offers the tools to agents once `register()` finishes.
   *
   * @param name - The tool's `name` from `extension.json`, e.g. `send_message`.
   * @param handler - Runs one call. See {@link ExtensionToolHandler}.
   * @throws When the name is not declared, was refused (its card in Settings
   *   says why), already has a handler, or `register()` already finished.
   */
  handle(name: string, handler: ExtensionToolHandler): void;
}

/**
 * Runs one call to a tool.
 *
 * `input` has already been checked against the declared input schema. Return
 * plain JSON (a string is passed through as text). Throw to fail the call: the
 * agent reads your error message, prefixed with your extension's name. Stop
 * work when `call.signal` aborts: the call's time ran out (`timeoutSeconds`),
 * the agent's turn was cancelled, or the extension is stopping. A result that
 * arrives after that is thrown away.
 */
export type ExtensionToolHandler = (
  input: unknown,
  call: ExtensionToolCall
) => unknown | Promise<unknown>;

/** What a handler is told about one call. Nothing else about the caller is shared. */
export interface ExtensionToolCall {
  /** Aborted when the call's time runs out, it is cancelled, or the extension stops. */
  readonly signal: AbortSignal;
  /** The Mesh id of the calling agent, when DorkOS knows which agent called; otherwise null. */
  readonly agentId: string | null;
}
