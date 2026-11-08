/**
 * Injected test double for runtime orchestration and SDK-shaped event fixtures.
 * Consumers mock the SDK; production never imports this helper. The real
 * launch/protection/conformance coverage uses the app-server transport.
 */
import { Codex, type CodexOptions } from '@openai/codex-sdk';
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import { buildCodexOptions } from './sdk-options.js';
import { withCodexCredits } from './sdk-credits.js';
import { mapCodexThread } from '../../event-mapper.js';
import { projectThreadOptions } from './thread-options.js';
import type { CodexTransport, CodexTurnRequest } from '../../transport/codex-transport.js';

/** A scripted stream per turn; no process launcher. */
export class ScriptedCodexTransport implements CodexTransport {
  readonly kind = 'exec' as const;
  constructor(
    private readonly client: (options: CodexOptions) => Codex = (options) => new Codex(options)
  ) {}
  /** Exec declares nothing beyond the shared Codex base (NOTES.md Verdicts 1–3). */
  readonly capabilities = {};

  /** Feed one scripted start/resume stream through the real event mapper. */
  async *runTurn(request: CodexTurnRequest): AsyncGenerator<StreamEvent> {
    const threadOptions = projectThreadOptions(
      request.settings,
      request.cwd,
      request.writableDirectories
    );
    const client = this.clientForTurn(request);
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

  /** The scripted stream stops through its AbortSignal; it has no acknowledgement. */
  async interrupt(): Promise<InterruptReceipt> {
    return { outcome: 'closed', runtime: 'codex' };
  }

  /** The scripted transport owns no background process. */
  async shutdown(): Promise<void> {}

  /** A fresh cheap SDK client carries only this turn's tools, secrets and file policy. */
  private clientForTurn(request: CodexTurnRequest): Codex {
    const options = buildCodexOptions(
      request.binary,
      request.tools.agentTokenEnv,
      request.tools.managed,
      request.tools.dorkosTools,
      request.tools.connectorTools
    );
    return this.client(
      request.launch.home === 'credits'
        ? withCodexCredits(options, request.launch.credits)
        : options
    );
  }
}
