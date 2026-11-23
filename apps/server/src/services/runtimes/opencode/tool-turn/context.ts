/** One existing OpenCode active turn's live policy and tool lifetime. */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { chosenModeWithinOwnBounds } from '../../../core/turn-power/full-autonomy.js';
import { effectiveApprovalMode } from '../messaging/approvals.js';
import { OPENCODE_CAPABILITIES } from '../runtime-constants.js';
import type { RuntimeToolTurnFacts } from '../../../connectors/runtime-principal-port.js';
import type { CapabilityHoldSession } from '../../../core/capabilities/capability-approval-hold.js';
import { hostTurnEvent, type OpenCodeHostEvent } from './host-events.js';

/** Transient host delivery into the existing wire queue, not another reader. */
export class OpenCodeToolTurnContext {
  private delivery: ((event: OpenCodeHostEvent) => void) | undefined;
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private readonly session: CapabilityHoldSession = {
    eventQueue: [],
    eventQueueNotify: () => {
      const events = this.session.eventQueue.splice(0);
      if (!this.isCurrent() || this.signal.aborted) return;
      for (const event of events) this.delivery?.(hostTurnEvent(event));
    },
  };

  /** Bind the exact owner and a fresh native-policy reader, not prepared settings. */
  constructor(
    private readonly isCurrent: () => boolean,
    private readonly readMode: () => string | undefined,
    private readonly ceiling: MessageOpts['permissionCeiling'],
    signal: AbortSignal
  ) {
    this.signal = AbortSignal.any([signal, this.lifetime.signal]);
  }

  /** Enable host delivery only after registration and the native queue are ready. */
  attach(delivery: (event: OpenCodeHostEvent) => void): void {
    if (!this.signal.aborted) this.delivery = delivery;
  }

  /** Read the same current mode source the native approval coordinator uses. */
  read(): RuntimeToolTurnFacts | undefined {
    if (!this.delivery || !this.isCurrent() || this.signal.aborted) return undefined;
    const mode = this.readMode();
    return {
      effectiveMode: effectiveApprovalMode(mode, this.ceiling),
      chosenMode: chosenModeWithinOwnBounds(
        OPENCODE_CAPABILITIES.permissionModes,
        mode,
        this.ceiling
      ),
      // OpenCode declares no person-only Never ask selector; Full is distinct.
      neverAsks: false,
      session: this.session,
      signal: this.signal,
    };
  }

  /** Retire holds synchronously, independently of a paused stream's final drain. */
  close(): void {
    this.delivery = undefined;
    this.lifetime.abort();
    this.session.eventQueue.splice(0);
  }
}
