/**
 * The rules `ctx.tools.handle` enforces, in one place both runtimes read
 * (DOR-2685, DOR-2686 task 6.1).
 *
 * The in-process binding (`tool-binding.ts`) and an isolated extension's proxy
 * ctx (`isolation/child/proxy-ctx.ts`) both call {@link toolHandleProblem}, so
 * an extension that binds a tool wrongly gets the same error, word for word,
 * wherever it runs. The child's check is a courtesy that keeps that shape; the
 * host still binds every isolated tool through the real `ctx.tools.handle`,
 * which runs this check again on its own copy of the manifest.
 *
 * Bundled into the isolated child, so it imports nothing at run time.
 *
 * @module services/extensions/agent-tools/tool-handle-rules
 */

/** What `handle` needs to know about one declared tool: discovery's verdict on it. */
export interface ToolHandleCheck {
  /** The tool's name inside its extension. */
  name: string;
  /** Whether discovery accepted it. */
  ok: boolean;
  /** Why discovery refused it, when it did. */
  reason?: string;
}

/** The pattern a tool name has to match to be quoted back in an error. */
const QUOTABLE_NAME = /^[a-z0-9_]{1,64}$/;

/**
 * Why `ctx.tools.handle(name, handler)` must throw, or `null` when the
 * binding is allowed.
 *
 * @param extensionId - The extension's id, for messages.
 * @param state - Whether `register()` is still running, discovery's verdict on
 *   each declared tool, and the names that already have a handler.
 * @param name - The name the extension passed.
 * @param handler - The handler the extension passed.
 * @returns The error to throw, or `null`.
 */
export function toolHandleProblem(
  extensionId: string,
  state: {
    open: boolean;
    checks: ReadonlyMap<string, ToolHandleCheck>;
    handled: { has(name: string): boolean };
  },
  name: unknown,
  handler: unknown
): Error | null {
  const label = typeof name === 'string' && QUOTABLE_NAME.test(name) ? `"${name}"` : 'a tool';
  if (!state.open) {
    return new Error(
      `ctx.tools.handle(${label}) was called after register() finished. ` +
        `Bind every tool while register() runs.`
    );
  }
  const check = typeof name === 'string' ? state.checks.get(name) : undefined;
  if (!check) {
    return new Error(
      `${extensionId} handles ${label}, but extension.json declares no tool by that name.`
    );
  }
  if (!check.ok) {
    return new Error(
      `${extensionId} handles ${label}, but DorkOS refused it: ${check.reason ?? 'it is invalid'}`
    );
  }
  if (state.handled.has(check.name)) {
    return new Error(`${extensionId} handles ${label} twice. Bind each tool once.`);
  }
  if (typeof handler !== 'function') {
    return new TypeError(`ctx.tools.handle(${label}) needs a handler function.`);
  }
  return null;
}
