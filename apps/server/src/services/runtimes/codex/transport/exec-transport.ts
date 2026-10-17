/**
 * The exec transport: every turn is one `codex exec` subprocess through
 * `@openai/codex-sdk` (ADR-0309, now the fallback behind
 * `runtimes.codex.transport`, ADR 261005-113107).
 *
 * This is the code `CodexRuntime.sendMessage` ran before the transport seam,
 * moved here unchanged: the client choice (`clientForTurn`), the options
 * (`buildCodexOptions`, `withCodexCredits`), the thread options
 * (`projectThreadOptions`), `runStreamed` and `mapCodexThread`. Secrets ride
 * the subprocess environment, never argv (`codex-options.ts`).
 *
 * @module services/runtimes/codex/transport/exec-transport
 */
import type { Codex } from '@openai/codex-sdk';
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import { runtimeInheritedNames } from '../../shared/runtime-environment-config.js';
import { buildCodexOptions, codexKeepAwakeConfig } from '../codex-options.js';
import { withCodexCredits } from '../credits-launch.js';
import { mapCodexThread } from '../event-mapper.js';
import { projectThreadOptions } from '../turn-input.js';
import type { CodexManagedMcpServers } from '../mcp-server-config.js';
import type { DorkosMcpInjection } from '../../shared/dorkos-mcp-injection.js';
import type { ConnectorRuntimeMcpInjection } from '../../connector-tools.js';
import type { CreditsLaunch } from '../../../core/cloud/credits-protocols.js';
import type { CodexTransport, CodexTurnRequest } from './codex-transport.js';

/** One `codex exec` per turn. */
export class ExecCodexTransport implements CodexTransport {
  readonly kind = 'exec' as const;
  /** Exec declares nothing beyond the shared Codex base (NOTES.md Verdicts 1–3). */
  readonly capabilities = {};

  /**
   * The shared client and the binary it was built for, or `null` until the
   * first turn resolves one. Built LAZILY: the SDK's `Codex` constructor
   * resolves its own vendored binary and THROWS when it cannot find one, which
   * in the packaged desktop app (where the vendor package is not shipped) took
   * the whole runtime out of the registry — no Codex card, no honest status, no
   * install hint (DOR-1334 / F9). Nothing here touches the SDK until a turn
   * actually needs it, and by then DorkOS has resolved the path itself.
   */
  private sharedClient: { binary: string; policy: string; client: Codex } | null = null;

  /**
   * Run one `codex exec` turn: resume when bound, start otherwise. The event
   * mapper guarantees exactly one terminal `done` on every path — completion,
   * failure, abort (a fired signal makes the SDK generator throw AbortError,
   * normalized to a quiet `done`), and crash.
   *
   * @param request - The resolved turn.
   */
  async *runTurn(request: CodexTurnRequest): AsyncGenerator<StreamEvent> {
    const threadOptions = projectThreadOptions(
      request.settings,
      request.cwd,
      request.writableDirectories
    );
    const client = await this.clientForTurn(
      request.binary,
      request.tools.agentTokenEnv,
      request.tools.managed,
      request.tools.dorkosTools,
      request.tools.connectorTools,
      request.launch.home === 'credits' ? request.launch.credits : null
    );
    request.signal.throwIfAborted();
    const thread =
      request.boundThreadId !== undefined
        ? client.resumeThread(request.boundThreadId, threadOptions)
        : client.startThread(threadOptions);
    let bound = request.boundThreadId !== undefined;
    const { events } = await thread.runStreamed(request.prompt, { signal: request.signal });
    for await (const event of mapCodexThread(events, request.events)) {
      // Persist the binding the moment thread.started reveals the id — before
      // the terminal done — so even an interrupted or crashed first turn stays
      // resumable.
      if (!bound && request.events.threadId !== undefined) {
        request.onThreadBound(request.events.threadId);
        bound = true;
      }
      yield event;
    }
  }

  /**
   * Exec's only stop primitive is the turn's `AbortSignal`, which the runtime
   * fires before calling this; it SIGTERMs the per-turn subprocess.
   *
   * **`closed`, never `acked`, and that is deliberate** (spec
   * `runtime-interrupt-receipts` D7). Nothing in codex exec acknowledges a stop;
   * the turn ends because the process died. It carries no `reason`: the reasons
   * all say why a graceful attempt was abandoned, and there is no graceful
   * attempt here to abandon.
   */
  async interrupt(): Promise<InterruptReceipt> {
    return { outcome: 'closed', runtime: 'codex' };
  }

  /** Nothing outlives a turn on exec. */
  async shutdown(): Promise<void> {}

  /**
   * The `Codex` client for one turn.
   *
   * Returns the shared client (subprocess receives a complete projected env)
   * unless this turn needs a turn-scoped one: it carries an agent identity
   * token, managed MCP servers, a `dorkos` or connector server (turn-bound
   * bearers), or runs on credits. Constructing a client is cheap next to
   * spawning the model subprocess.
   */
  private async clientForTurn(
    binary: string,
    tokenEnv: Record<string, string>,
    managed: CodexManagedMcpServers,
    dorkosTools: DorkosMcpInjection | null,
    connectorTools: ConnectorRuntimeMcpInjection | null,
    credits: CreditsLaunch | null
  ): Promise<Codex> {
    const { Codex } = await import('@openai/codex-sdk');
    if (credits) {
      return new Codex(
        withCodexCredits(
          buildCodexOptions(binary, tokenEnv, managed, dorkosTools, connectorTools),
          credits
        )
      );
    }
    const hasToken = Object.keys(tokenEnv).length > 0;
    const hasManaged = Object.keys(managed.servers).length > 0;
    if (hasToken || hasManaged || dorkosTools || connectorTools) {
      return new Codex(buildCodexOptions(binary, tokenEnv, managed, dorkosTools, connectorTools));
    }
    // The keep-awake setting is part of the key: the shared client's options
    // carry Codex's own sleep inhibitor, so a toggle must rebuild it.
    const policy = JSON.stringify([runtimeInheritedNames('codex'), codexKeepAwakeConfig()]);
    if (this.sharedClient?.binary !== binary || this.sharedClient.policy !== policy) {
      this.sharedClient = { binary, policy, client: new Codex(buildCodexOptions(binary)) };
    }
    return this.sharedClient.client;
  }
}
