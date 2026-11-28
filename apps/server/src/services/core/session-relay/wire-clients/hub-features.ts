/**
 * The computer's half of the agent-computer hello (spec
 * `space-computer-contract` §4.1, step W1, DOR-5164): what the home agreed to,
 * and the calls this computer makes on that agreement.
 *
 * A computer that named no agent-computer feature in its `hello` reads its
 * home's frames exactly as before, with the strict `RelayWebFrameSchema`, so a
 * `features` frame or an agent-computer request still closes its connection.
 *
 * A computer that named one reads with `AgentComputerWebFrameSchema` and:
 *
 * - accepts the home's `features` frame only as the first sealed frame after
 *   its `finish`, and only once; a second one, or one after any other frame,
 *   closes the connection. A replayed frame never opens (the channel's
 *   sequence), so it closes too;
 * - agrees to the intersection of both signed lists, and nothing until the
 *   frame arrives, so an older home that sends none is asked nothing;
 * - refuses a call outside that set before it is sent, naming the feature;
 * - answers a home request it does not serve with `needs_update`, naming the
 *   feature, and keeps the connection.
 *
 * @module services/core/session-relay/wire-clients/hub-features
 */
import {
  AGENT_COMPUTER_RELAY_FEATURES,
  AgentComputerWebFrameSchema,
  encodeRelayCallFrame,
  missingRelayCallFeature,
  parseRelayCallResult,
  type RelayCall,
  type RelayCallResultFrame,
} from '@dorkos/shared/session-relay-agent-computer';
import {
  RelayWebFrameSchema,
  decodeRelayFrame,
  type RelayComputerFrame,
  type RelayError,
  type RelayWebFrame,
} from '@dorkos/shared/session-relay';
import {
  agreedAgentComputerFeatures,
  namesAgentComputerFeature,
  wireFeatureRefusal,
  type AgentComputerFeature,
} from '@dorkos/shared/wire/features';

/** How long one call waits for its `call.result`. */
export const RELAY_CALL_TIMEOUT_MS = 30_000;

/** The connection ended, or never opened, before the call was answered. */
export const RELAY_HUB_OFFLINE: RelayError = {
  status: 503,
  code: 'internal',
  message: 'This computer’s DorkOS in the cloud is not connected right now.',
};

/** The home did not answer a call in time. */
const CALL_TIMED_OUT: RelayError = {
  status: 504,
  code: 'internal',
  message: 'This computer’s DorkOS in the cloud did not answer in time.',
};

/** The home's answer did not match the call. */
const CALL_BAD_ANSWER: RelayError = {
  status: 502,
  code: 'internal',
  message: 'This computer’s DorkOS in the cloud sent an answer that could not be read.',
};

/** A call's outcome: the checked answer body, or why there is none. */
export type RelayCallOutcome = { ok: true; body: unknown } | { ok: false; error: RelayError };

/** What one opened inner frame from the home comes to. */
export type HubFrameRead =
  /** A frame for the chat operations: handle it as before. */
  | { kind: 'web'; frame: RelayWebFrame }
  /** Answer the home with this frame. */
  | { kind: 'reply'; frame: RelayComputerFrame }
  /** Taken care of here. */
  | { kind: 'handled' }
  /** Close the connection. */
  | { kind: 'close' };

interface PendingCall {
  op: RelayCall['op'];
  resolve: (outcome: RelayCallOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One connection's agreement with its home, and the calls made on it. */
export class HubFeatureLink {
  private agreedSet: readonly AgentComputerFeature[] = [];
  private heard = false;
  private nextId = 0;
  private readonly pending = new Map<string, PendingCall>();
  /** Whether this computer named an agent-computer feature in its `hello`. */
  readonly speaks: boolean;

  /**
   * Start a connection's agreement: nothing is agreed until the home's frame.
   *
   * @param named - The features this computer named in its `hello`.
   * @param callTimeoutMs - How long a call waits; injectable for tests.
   */
  constructor(
    private readonly named: readonly string[],
    private readonly callTimeoutMs = RELAY_CALL_TIMEOUT_MS
  ) {
    this.speaks = namesAgentComputerFeature(named);
  }

  /** The agent-computer features both sides named; empty until the home's frame arrives. */
  get agreed(): readonly AgentComputerFeature[] {
    return this.agreedSet;
  }

  /**
   * Read one opened inner frame from the home.
   *
   * @param inner - The opened inner frame's text.
   */
  read(inner: string): HubFrameRead {
    const first = !this.heard;
    this.heard = true;
    if (!this.speaks) {
      const frame = decodeRelayFrame(inner, RelayWebFrameSchema);
      return frame ? { kind: 'web', frame } : { kind: 'close' };
    }
    const frame = decodeRelayFrame(inner, AgentComputerWebFrameSchema);
    if (!frame) return { kind: 'close' };
    switch (frame.type) {
      case 'features':
        if (!first) return { kind: 'close' };
        this.agreedSet = agreedAgentComputerFeatures(this.named, frame.features);
        return { kind: 'handled' };
      case 'call.result':
        this.settle(frame);
        return { kind: 'handled' };
      case 'request': {
        const op = frame.request.op;
        if (!(AGENT_COMPUTER_RELAY_FEATURES as readonly string[]).includes(op)) {
          return { kind: 'web', frame: frame as RelayWebFrame };
        }
        // No agent-computer request is served yet (W1), agreed or not.
        const feature = op as AgentComputerFeature;
        return {
          kind: 'reply',
          frame: { type: 'error', id: frame.id, ok: false, error: wireFeatureRefusal(feature) },
        };
      }
      default:
        return { kind: 'web', frame };
    }
  }

  /**
   * Make one call to the home, or refuse it here when the home did not agree
   * to its feature. Never rejects.
   *
   * @param call - The call.
   * @param send - Seal and send the call's text; `false` when it could not go out.
   */
  call(call: RelayCall, send: (text: string) => boolean): Promise<RelayCallOutcome> {
    const feature = missingRelayCallFeature(this.agreedSet, call);
    if (feature !== null) {
      return Promise.resolve({ ok: false, error: wireFeatureRefusal(feature) });
    }
    this.nextId += 1;
    const id = `c${this.nextId}`;
    const encoded = encodeRelayCallFrame(id, call);
    if (!encoded.ok) return Promise.resolve({ ok: false, error: encoded.error });
    if (!send(encoded.text)) return Promise.resolve({ ok: false, error: RELAY_HUB_OFFLINE });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, error: CALL_TIMED_OUT });
      }, this.callTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { op: call.op, resolve, timer });
    });
  }

  /** The connection ended: every call still waiting fails. */
  closeAll(): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const call of waiting) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: RELAY_HUB_OFFLINE });
    }
  }

  private settle(frame: RelayCallResultFrame): void {
    const call = this.pending.get(frame.id);
    if (!call) return;
    this.pending.delete(frame.id);
    clearTimeout(call.timer);
    if (!frame.ok) {
      call.resolve({ ok: false, error: frame.error });
      return;
    }
    const body = parseRelayCallResult(call.op, frame.body);
    call.resolve(body === null ? { ok: false, error: CALL_BAD_ANSWER } : { ok: true, body });
  }
}
