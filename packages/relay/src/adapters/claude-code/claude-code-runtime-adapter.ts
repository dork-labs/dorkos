/**
 * Claude Code runtime adapter — bridges the abstract `RuntimeAdapter` base
 * to the Claude Agent SDK via the `AgentRuntimeLike` structural interface.
 *
 * This sits *inside* `ClaudeCodeAdapter` (the relay-level wrapper) and owns
 * the runtime-lifecycle concerns: per-session serial queueing, session
 * open/close, and streaming. The relay-level class continues to own
 * payload parsing, trace spans, response publishing, and correlation —
 * concerns that are about the relay, not the runtime.
 *
 * @module relay/adapters/claude-code-runtime-adapter
 */

import type { StreamEvent } from '@dorkos/shared/types';
import {
  RuntimeAdapter,
  type RuntimeAdapterContext,
  type RuntimeInboundMessage,
  type RuntimeOutboundEvent,
  type RuntimeSessionHandle,
} from '../runtime-adapter.js';
import type { AgentRuntimeLike } from './types.js';

/**
 * Options forwarded to `agentRuntime.ensureSession()` and `sendMessage()`.
 *
 * Carried on the session handle so `streamEvents` can forward them to
 * `sendMessage` without requiring a second plumbing path.
 */
export interface ClaudeCodeRuntimeSessionOpts {
  readonly permissionMode: string;
  readonly cwd?: string;
  readonly hasStarted?: boolean;
  readonly systemPromptAppend?: string;
}

/**
 * Session handle returned by `openSession`. Carries the session key plus
 * the per-dispatch options needed when `streamEvents` calls `sendMessage`.
 */
export type ClaudeCodeSessionHandle = RuntimeSessionHandle & {
  readonly opts: ClaudeCodeRuntimeSessionOpts;
};

/**
 * Claude Code-specific concrete subclass of `RuntimeAdapter`.
 *
 * Implements the three abstract hooks by delegating to an injected
 * `AgentRuntimeLike`. `closeSession` is a no-op because the SDK manages
 * its own per-session teardown.
 *
 * Exposes `enqueueForSession` publicly (via `enqueue()`) so the relay-level
 * `ClaudeCodeAdapter` can reuse the same per-session serialization that
 * the base class already provides, replacing the removed `AgentQueue`.
 */
export class ClaudeCodeRuntimeAdapter extends RuntimeAdapter {
  private readonly agentRuntime: AgentRuntimeLike;
  /** Transient per-invocation options, keyed by sessionId. */
  private readonly pendingOpts = new Map<string, ClaudeCodeRuntimeSessionOpts>();

  constructor(ctx: RuntimeAdapterContext, agentRuntime: AgentRuntimeLike) {
    super(ctx);
    this.agentRuntime = agentRuntime;
  }

  /**
   * Serialize `fn` against prior invocations for the same `sessionId`.
   *
   * Public wrapper over the base's protected `enqueueForSession` so the
   * relay-level wrapper can drive per-session ordering of arbitrary work
   * (trace span updates, publish sequencing, etc.) through the same lock.
   */
  enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueueForSession(sessionId, fn);
  }

  /** Number of sessions with pending queue entries (diagnostic). */
  get queueSize(): number {
    return this.queuedSessionCount;
  }

  /** Drop all per-session queues. Called by the relay-level wrapper on stop. */
  reset(): void {
    this.clearSessionQueues();
    this.pendingOpts.clear();
  }

  /**
   * Seed the per-invocation options used by the next `openSession`/`streamEvents`
   * cycle for `sessionId`. Callers that use `streamMessage()` directly (tests,
   * future migrations) should call this first; the relay-level wrapper bypasses
   * `streamMessage` and calls the SDK directly, so it does not need this.
   */
  prepareSession(sessionId: string, opts: ClaudeCodeRuntimeSessionOpts): void {
    this.pendingOpts.set(sessionId, opts);
  }

  // ---- Abstract runtime hooks ----

  protected async openSession(sessionId: string): Promise<ClaudeCodeSessionHandle> {
    const opts = this.pendingOpts.get(sessionId) ?? { permissionMode: 'default' };
    this.agentRuntime.ensureSession(sessionId, {
      permissionMode: opts.permissionMode,
      hasStarted: opts.hasStarted ?? false,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return { sessionId, opts };
  }

  protected async *streamEvents(
    handle: RuntimeSessionHandle,
    message: RuntimeInboundMessage,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const { sessionId, opts } = handle as ClaudeCodeSessionHandle;
    const eventStream = this.agentRuntime.sendMessage(sessionId, message.content, {
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.systemPromptAppend ? { systemPromptAppend: opts.systemPromptAppend } : {}),
    });

    try {
      for await (const event of eventStream) {
        if (signal.aborted) break;
        yield event;
      }
    } finally {
      this.pendingOpts.delete(sessionId);
    }
  }

  protected async closeSession(_handle: RuntimeSessionHandle): Promise<void> {
    // SDK manages its own teardown; nothing to do here.
  }

  protected normalizeEvent(raw: unknown): RuntimeOutboundEvent {
    // StreamEvent shapes already satisfy `RuntimeOutboundEvent`. Defer to
    // the base for the structural cast rather than duplicating the check.
    return super.normalizeEvent(raw);
  }
}
