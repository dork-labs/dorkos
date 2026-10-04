/**
 * Binding an extension's tool handlers (`ctx.tools.handle`) and running them
 * on an agent's behalf (spec `extension-agent-tools-and-skills` §3-§5,
 * DOR-2685).
 *
 * Two halves:
 *
 * - {@link createToolBinding} builds `ctx.tools` for one starting instance.
 *   `handle` accepts only a tool the manifest declares and discovery accepted,
 *   once, and only while `register()` runs. {@link ToolBinding.seal} closes it
 *   when `register()` finishes and says which declared tools were handled.
 * - {@link RunningExtensionTools} is one running instance's tools: the
 *   contribution handed to the capability registry, and the host-built
 *   `invoke` behind every tool. {@link RunningExtensionTools.stop} takes the
 *   tools out of the registry FIRST, then marks the instance stopped and
 *   aborts every call still running, so a stopped instance's handler never
 *   starts again and a late result is thrown away.
 *
 * Nothing an extension returns or throws reaches the agent as anything but a
 * plain value or a {@link CapabilityToolError} built here: a thrown object of
 * any class becomes a fresh error carrying only its (capped, path-free)
 * message, and a returned value is copied through JSON, so no class instance
 * the envelope treats specially can ride out.
 *
 * @module services/extensions/agent-tools/tool-binding
 */
import type {
  ExtensionToolCall,
  ExtensionToolHandler,
  ToolsApi,
} from '@dorkos/extension-api/server';

import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import type { ContributeResult, CapabilityRegistry } from '../../core/capabilities/registry.js';
import type {
  ExtensionContribution,
  ExtensionToolContext,
  ExtensionToolSpec,
} from '../../core/capabilities/extension-contribution.js';
import { resolveAgentIdForPath } from '../../mesh/agent-path-lookup.js';
import { logger } from '../../../lib/logger.js';
import type { AcceptedExtensionTool, ExtensionToolCheck } from '@dorkos/extension-api/tool-check';

/**
 * The largest result, serialized, an agent is handed. A tool result lands in
 * the model's context whole; past this it would crowd out the conversation.
 */
export const EXTENSION_TOOL_RESULT_MAX_BYTES = 256 * 1024;

/** The longest piece of a handler's error message an agent reads. */
const MAX_ERROR_MESSAGE = 500;

/** Machine-readable codes on the errors this module builds. */
export const EXTENSION_TOOL_ERROR_CODES = {
  /** The handler threw or rejected. */
  failed: 'EXTENSION_TOOL_FAILED',
  /** The call ran past its `timeoutSeconds`. */
  timeout: 'EXTENSION_TOOL_TIMEOUT',
  /** The extension stopped while the call ran. */
  stopped: 'EXTENSION_TOOL_STOPPED',
  /** The caller cancelled the call. */
  cancelled: 'EXTENSION_TOOL_CANCELLED',
  /** The instance holding the tool is no longer running. */
  unavailable: 'EXTENSION_TOOL_UNAVAILABLE',
  /** The result was not JSON, or too large. */
  badResult: 'EXTENSION_TOOL_BAD_RESULT',
} as const;

/** A tool error an agent reads: one sentence and a code. */
function toolError(message: string, code: string): CapabilityToolError {
  return new CapabilityToolError({ error: message, code });
}

/**
 * Where a file path may start: a `file:` URL, an absolute or home-relative
 * POSIX path, a Windows drive path with either slash (`C:\…`, `C:/…`), or a
 * UNC share (`\\server\share`). A web URL is not a start: its first `/`
 * follows a `:`, and every later one follows a word character or a `/`.
 */
const PATH_START =
  /file:\/\/|(?<![\w:/.~\\-])(?:~|\.{1,2})?\/(?=[^\s/])|\b[A-Za-z]:[\\/]|(?<![\w\\])\\\\(?=[^\s\\])/gi;

/** What ends the clause a path sits in: a quote, a line break, or punctuation followed by a space. */
const CLAUSE_END = /["'`\n<>|]|[,;:)] |\s\(/;

/**
 * Replace file paths in a message with `<path>`, so a handler's
 * `ENOENT: no such file, open '/Users/…'` tells the agent what failed without
 * telling it where this machine keeps things.
 *
 * A path may hold spaces (`/Users/ana lee/My Documents/x`), so each one is
 * redacted through the last word of its clause that still holds a slash or
 * backslash. That errs toward hiding a word too many rather than leaving the
 * end of a path behind.
 */
function redactPaths(message: string): string {
  let out = '';
  let cursor = 0;
  PATH_START.lastIndex = 0;
  for (let match = PATH_START.exec(message); match; match = PATH_START.exec(message)) {
    const start = match.index;
    if (start < cursor) continue;
    const rest = message.slice(start);
    const clauseEnd = rest.slice(match[0].length).search(CLAUSE_END);
    const clause = clauseEnd === -1 ? rest : rest.slice(0, match[0].length + clauseEnd);
    // Through the last word of the clause that still holds a separator.
    let end = 0;
    let offset = 0;
    for (const word of clause.split(/(\s+)/)) {
      offset += word.length;
      if (/[\\/]/.test(word)) end = offset;
    }
    out += message.slice(cursor, start) + '<path>';
    cursor = start + Math.max(end, match[0].length);
    PATH_START.lastIndex = cursor;
  }
  return out + message.slice(cursor);
}

/**
 * The message a handler's throw carries, made safe for an agent: only the
 * message (never a stack), one line, paths redacted, capped.
 */
function safeMessage(err: unknown): string {
  let raw: string;
  try {
    raw =
      err instanceof Error
        ? String(err.message)
        : typeof err === 'string'
          ? err
          : 'it failed without saying why';
  } catch {
    raw = 'it failed without saying why';
  }
  const flat = redactPaths(raw)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const text = flat === '' ? 'it failed without saying why' : flat;
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE - 1)}…` : text;
}

/** `ctx.tools` for one starting instance, and the switch that closes it. */
export interface ToolBinding {
  /** The API handed to the extension as `ctx.tools`. */
  api: ToolsApi;
  /**
   * Close `handle` (called once `register()` finished) and report which
   * accepted tools got a handler and which never did.
   */
  seal(): {
    handled: Array<{ tool: AcceptedExtensionTool; handler: ExtensionToolHandler }>;
    unhandled: AcceptedExtensionTool[];
  };
  /** Close `handle` without reporting: this instance will never run. */
  close(): void;
}

/**
 * Build `ctx.tools` for one starting instance.
 *
 * @param extensionId - The extension's id, for messages.
 * @param checks - Discovery's decision on each declared tool
 *   (`checkDeclaredTools`), so `handle` can tell a refused tool from an
 *   undeclared one.
 */
export function createToolBinding(
  extensionId: string,
  checks: readonly ExtensionToolCheck[]
): ToolBinding {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const handlers = new Map<string, ExtensionToolHandler>();
  let open = true;

  const api: ToolsApi = Object.freeze({
    handle(name: string, handler: ExtensionToolHandler): void {
      const label =
        typeof name === 'string' && /^[a-z0-9_]{1,64}$/.test(name) ? `"${name}"` : 'a tool';
      if (!open) {
        throw new Error(
          `ctx.tools.handle(${label}) was called after register() finished. ` +
            `Bind every tool while register() runs.`
        );
      }
      const check = typeof name === 'string' ? byName.get(name) : undefined;
      if (!check) {
        throw new Error(
          `${extensionId} handles ${label}, but extension.json declares no tool by that name.`
        );
      }
      if (!check.ok) {
        throw new Error(`${extensionId} handles ${label}, but DorkOS refused it: ${check.reason}`);
      }
      if (handlers.has(name)) {
        throw new Error(`${extensionId} handles ${label} twice. Bind each tool once.`);
      }
      if (typeof handler !== 'function') {
        throw new TypeError(`ctx.tools.handle(${label}) needs a handler function.`);
      }
      handlers.set(name, handler);
    },
  });

  return {
    api,
    seal() {
      open = false;
      const handled: Array<{ tool: AcceptedExtensionTool; handler: ExtensionToolHandler }> = [];
      const unhandled: AcceptedExtensionTool[] = [];
      for (const check of checks) {
        if (!check.ok) continue;
        const handler = handlers.get(check.name);
        if (handler) handled.push({ tool: check, handler });
        else unhandled.push(check);
      }
      return { handled, unhandled };
    },
    close() {
      open = false;
      handlers.clear();
    },
  };
}

/** Where one declared tool stands for a running instance. */
export interface RunningToolStatus {
  /** `active` once the registry holds it; `refused` with a reason otherwise. */
  status: 'active' | 'inactive' | 'refused';
  /** Why it is refused. */
  reason?: string;
}

/**
 * One running instance's tools, from contribution to stop.
 *
 * Every definition it contributes closes over THIS instance. A restarted
 * extension is a new instance with new definitions, so an approval card still
 * open on the old one can never run the new handler's code under the old
 * instance's name, and the old handler never runs once this one stopped.
 */
export class RunningExtensionTools {
  private stopped = false;
  private readonly stopController = new AbortController();
  private handle: Extract<ContributeResult, { ok: true }> | undefined;
  private readonly handlers: ReadonlyMap<string, ExtensionToolHandler>;
  private readonly statuses = new Map<string, RunningToolStatus>();

  /**
   * Hold one started instance's handled tools until they are contributed.
   *
   * @param extensionId - The extension's id.
   * @param displayName - Its manifest name, which prefixes every error.
   * @param handled - The accepted tools that got a handler.
   * @param problems - Tools that will not be offered, with why (refused at
   *   discovery, or declared but never handled).
   */
  constructor(
    private readonly extensionId: string,
    private readonly displayName: string,
    private readonly handled: ReadonlyArray<{
      tool: AcceptedExtensionTool;
      handler: ExtensionToolHandler;
    }>,
    problems: ReadonlyArray<{ name: string; reason: string }>
  ) {
    this.handlers = new Map(handled.map(({ tool, handler }) => [tool.name, handler]));
    for (const { name, reason } of problems) this.statuses.set(name, { status: 'refused', reason });
    for (const { tool } of handled) this.statuses.set(tool.name, { status: 'inactive' });
  }

  /** Whether this instance has any tool to offer. */
  get hasTools(): boolean {
    return this.handled.length > 0;
  }

  /** Whether the registry holds this instance's tools right now. */
  get contributed(): boolean {
    return this.handle !== undefined;
  }

  /** Where each declared tool stands, by name. */
  statusOf(name: string): RunningToolStatus | undefined {
    return this.statuses.get(name);
  }

  /**
   * Hand the tools to the registry, once. A refusal leaves the extension
   * running without tools and records why on every tool.
   *
   * @param registry - The live capability registry.
   * @returns The refusal sentence, or `undefined` when the tools are in (or
   *   there were none, or this instance already stopped).
   */
  contribute(registry: CapabilityRegistry): string | undefined {
    if (this.stopped || this.handle || !this.hasTools) return undefined;
    const result = registry.contribute(this.contribution());
    if (!result.ok) {
      for (const { tool } of this.handled) {
        this.statuses.set(tool.name, { status: 'refused', reason: result.reason });
      }
      logger.warn(`[ext:${this.extensionId}] its tools were not registered: ${result.reason}`);
      return result.reason;
    }
    this.handle = result;
    for (const { tool } of this.handled) this.statuses.set(tool.name, { status: 'active' });
    logger.info(
      `[ext:${this.extensionId}] gave agents ${this.handled.length} tool(s): ` +
        this.handled.map(({ tool }) => tool.name).join(', ')
    );
    return undefined;
  }

  /**
   * Stop: take the tools out of the registry FIRST (no new call can find
   * them), then mark this instance stopped (a call that found them a moment
   * ago is refused before its handler starts), then abort every call still
   * running (its handler is told, and its result is thrown away).
   */
  stop(): void {
    if (this.stopped) return;
    this.handle?.remove();
    this.handle = undefined;
    this.stopped = true;
    this.stopController.abort();
    for (const { tool } of this.handled) this.statuses.set(tool.name, { status: 'inactive' });
  }

  /** The contribution: host-built specs, each with this instance's wrapper. */
  private contribution(): ExtensionContribution {
    const tools: ExtensionToolSpec[] = this.handled.map(({ tool }) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      tier: tool.tier,
      input: tool.input,
      ...(tool.approvalDisplayFields ? { approvalDisplayFields: tool.approvalDisplayFields } : {}),
      invoke: (input, context) => this.invoke(tool, input, context),
    }));
    return { owner: this.extensionId, displayName: this.displayName, tools };
  }

  /**
   * Run one call. The registry already parsed the input and ran the gate, so
   * the deadline starts now and a person's approval time never counts.
   */
  private async invoke(
    tool: AcceptedExtensionTool,
    input: unknown,
    context: ExtensionToolContext
  ): Promise<unknown> {
    const name = this.displayName;
    const handler = this.handlers.get(tool.name);
    if (this.stopped || !handler) {
      throw toolError(
        `${name} isn't available right now: it is stopped or restarting.`,
        EXTENSION_TOOL_ERROR_CODES.unavailable
      );
    }

    const controller = new AbortController();
    let why: 'timeout' | 'stopped' | 'cancelled' | undefined;
    const abort = (reason: 'timeout' | 'stopped' | 'cancelled'): void => {
      if (controller.signal.aborted) return;
      why = reason;
      controller.abort();
    };
    const onStop = (): void => abort('stopped');
    const onCancel = (): void => abort('cancelled');
    this.stopController.signal.addEventListener('abort', onStop, { once: true });
    context.signal?.addEventListener('abort', onCancel, { once: true });
    if (context.signal?.aborted) abort('cancelled');
    const timer = setTimeout(() => abort('timeout'), tool.timeoutSeconds * 1000);
    timer.unref?.();

    const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
      if (controller.signal.aborted) resolve({ kind: 'aborted' });
      else
        controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), {
          once: true,
        });
    });

    // Spec 2.3 reads the id off `context.identity`, but an identity carries the
    // agent's folder, not its Mesh id; the folder is resolved to the Mesh id
    // the rest of DorkOS (and `ctx.agent.send`) uses, and `null` when no
    // registered agent lives there.
    let agentId: string | null;
    try {
      agentId = resolveAgentIdForPath(context.agent?.path) ?? null;
    } catch {
      agentId = null;
    }
    const call: ExtensionToolCall = Object.freeze({ signal: controller.signal, agentId });

    try {
      const outcome = await Promise.race([
        // Started from a resolved promise, so a handler that throws
        // synchronously is caught the same way as one that rejects.
        Promise.resolve()
          .then(() => (controller.signal.aborted ? undefined : handler(input, call)))
          .then(
            (value) => ({ kind: 'value' as const, value }),
            (error: unknown) => ({ kind: 'error' as const, error })
          ),
        aborted,
      ]);

      // Checked after the handler settled, too: a result that lands after the
      // extension stopped (or the deadline passed) is thrown away.
      if (this.stopped || why === 'stopped') {
        throw toolError(`${name} stopped while this ran.`, EXTENSION_TOOL_ERROR_CODES.stopped);
      }
      if (why === 'timeout') {
        throw toolError(
          `${name} didn't answer in ${tool.timeoutSeconds} seconds.`,
          EXTENSION_TOOL_ERROR_CODES.timeout
        );
      }
      if (why === 'cancelled') {
        throw toolError(`${name}: the call was cancelled.`, EXTENSION_TOOL_ERROR_CODES.cancelled);
      }
      if (outcome.kind === 'error') {
        const message = safeMessage(outcome.error);
        logger.warn(`[ext:${this.extensionId}] tool ${tool.name} failed: ${message}`);
        throw toolError(`${name}: ${message}`, EXTENSION_TOOL_ERROR_CODES.failed);
      }
      if (outcome.kind === 'value') return this.plainResult(outcome.value);
      throw toolError(`${name} stopped while this ran.`, EXTENSION_TOOL_ERROR_CODES.stopped);
    } finally {
      clearTimeout(timer);
      this.stopController.signal.removeEventListener('abort', onStop);
      context.signal?.removeEventListener('abort', onCancel);
      // A handler still running after its call ended is told to stop.
      abort('cancelled');
    }
  }

  /**
   * Turn a handler's return value into what the agent reads: a string as-is,
   * anything else as a fresh JSON copy (so no getter, `toJSON` or class
   * instance survives past this point), within the size cap.
   */
  private plainResult(value: unknown): unknown {
    const name = this.displayName;
    let serialized: string | undefined;
    try {
      serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    } catch {
      serialized = undefined;
    }
    if (typeof serialized !== 'string') {
      throw toolError(
        `${name} returned something that isn't plain data.`,
        EXTENSION_TOOL_ERROR_CODES.badResult
      );
    }
    if (Buffer.byteLength(serialized, 'utf8') > EXTENSION_TOOL_RESULT_MAX_BYTES) {
      throw toolError(
        `${name} returned more than the agent can read.`,
        EXTENSION_TOOL_ERROR_CODES.badResult
      );
    }
    return typeof value === 'string' ? value : (JSON.parse(serialized) as unknown);
  }
}
