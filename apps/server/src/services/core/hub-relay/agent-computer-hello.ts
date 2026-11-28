/**
 * The home's half of the agent-computer hello (spec `space-computer-contract`
 * §4.1, step W1, DOR-5164): the `features` frame, the agreed set, and the
 * calls a connection refuses while it stays open.
 *
 * A connection takes this path only when all of these hold:
 *
 * - the home's own record says the computer is an agent computer (`role`),
 *   never anything the computer sent;
 * - the `remoteComputers.enabled` experiment is on (`agentComputers`).
 *
 * Otherwise nothing here runs and the connection is today's: frames decode
 * with `RelayComputerFrameSchema`, and a `call` closes it.
 *
 * On this path the home sends one sealed `features` frame, first, and only when
 * the computer's `hello` named an agent-computer feature. It fixes the agreed
 * set once, for the life of the connection: the intersection of both signed
 * lists. It decodes every frame with `AgentComputerFrameSchema` and never falls
 * back to a looser schema. A `call` outside the agreed set, or one it cannot
 * read, is answered with a refusing `call.result` and the connection stays up;
 * past {@link HOME_MAX_REFUSALS} refusals in {@link HOME_REFUSAL_WINDOW_MS} it
 * closes. Any other frame it cannot read closes it, as today.
 *
 * @module services/core/hub-relay/agent-computer-hello
 */
import {
  AgentComputerFrameSchema,
  encodeRelayCallResultFrame,
  missingRelayCallFeature,
  readRelayCallId,
  relayCallRefusalFrame,
  type RelayCall,
  type RelayCallFeature,
  type RelayFeaturesFrame,
} from '@dorkos/shared/session-relay-agent-computer';
import {
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayComputerFrame,
  type RelayError,
} from '@dorkos/shared/session-relay';
import {
  agreedAgentComputerFeatures,
  homeFeaturesFrameFor,
  wireFeatureRefusal,
  type AgentComputerFeature,
} from '@dorkos/shared/wire/features';

/** What the home's own record says a linked computer is. */
export type LinkedComputerRole = 'computer' | 'agent-computer';

/** Most refused calls a connection may send in one window before it is closed. */
export const HOME_MAX_REFUSALS = 32;

/** The window {@link HOME_MAX_REFUSALS} is counted over. */
export const HOME_REFUSAL_WINDOW_MS = 60_000;

/** A served call failed on the home: the computer's tool fails with this. */
const CALL_FAILED: RelayError = {
  status: 500,
  code: 'internal',
  message: 'DorkOS could not answer that call.',
};

/** The calls this home serves. Its features are the only calls it names. */
export interface HomeCallServer {
  /** The calls served; the home's `features` frame names these and nothing else. */
  readonly features: readonly RelayCallFeature[];
  /** Answer one call the computer may make. The body is checked before it is sent. */
  serve(call: RelayCall): Promise<unknown>;
}

/** What a connection is told about the agent-computer path. */
export interface AgentComputerHomeOptions {
  /**
   * What the home's record says this computer is; `computer` when not given.
   * In W1 the endpoint never sets it, so every live connection is a
   * `computer` and only tests reach this path. Step W2 reads it from the
   * home's record (`LinkedComputer` v2); it never comes from `hello`.
   */
  role?: LinkedComputerRole;
  /** Whether the `remoteComputers.enabled` experiment is on, read once when the computer proves itself. */
  agentComputers?: () => boolean;
  /** The calls this home serves. None in W1. */
  calls?: HomeCallServer;
  /** The clock for counting refusals; injectable for tests. */
  now?: () => number;
}

/** What one opened inner frame from an agent computer comes to. */
export type AgentComputerRead =
  | { kind: 'frame'; frame: RelayComputerFrame }
  | { kind: 'answered' }
  /** Close; `refusals` when the computer passed {@link HOME_MAX_REFUSALS}. */
  | { kind: 'close'; reason?: 'refusals' };

/** One agent computer's connection, as far as the hello and its calls go. */
export class AgentComputerLink {
  /** The features both sides named, fixed when the computer proved itself. */
  readonly agreed: readonly AgentComputerFeature[];
  /** The frame to send first, or `null` when the computer named no agent-computer feature. */
  readonly featuresFrame: RelayFeaturesFrame | null;
  private readonly refusedAt: number[] = [];

  /**
   * The link for a connection that just proved itself, or `null` when the
   * connection takes today's path.
   *
   * @param options - The connection's options.
   * @param hello - The features the computer named in its signed `hello`.
   * @param send - Seal and send one inner frame's text; `false` when it could not go out.
   */
  static open(
    options: AgentComputerHomeOptions,
    hello: readonly string[],
    send: (text: string) => boolean
  ): AgentComputerLink | null {
    if ((options.role ?? 'computer') !== 'agent-computer') return null;
    if (options.agentComputers?.() !== true) return null;
    return new AgentComputerLink(options, hello, send);
  }

  private constructor(
    private readonly options: AgentComputerHomeOptions,
    hello: readonly string[],
    private readonly send: (text: string) => boolean
  ) {
    const home: readonly AgentComputerFeature[] = options.calls?.features ?? [];
    this.featuresFrame = homeFeaturesFrameFor(hello, home);
    this.agreed = this.featuresFrame ? agreedAgentComputerFeatures(hello, home) : [];
  }

  /**
   * Read one opened inner frame. A frame the chat operations use comes back
   * for the connection to handle; a call is answered here.
   *
   * @param inner - The opened inner frame's text.
   */
  read(inner: string): AgentComputerRead {
    const frame = decodeRelayFrame(inner, AgentComputerFrameSchema);
    if (frame === null) {
      // Only a call is answered rather than closed on, and its refusal names
      // nothing from it but the id it is answering.
      const id = readRelayCallId(inner);
      return id === null ? { kind: 'close' } : this.refuse(id, wireFeatureRefusal());
    }
    if (frame.type !== 'call') return { kind: 'frame', frame };
    const missing = missingRelayCallFeature(this.agreed, frame.call);
    if (missing !== null) return this.refuse(frame.id, wireFeatureRefusal(missing));
    this.serve(frame.id, frame.call);
    return { kind: 'answered' };
  }

  private refuse(id: string, error: RelayError): AgentComputerRead {
    const now = (this.options.now ?? Date.now)();
    while (now - (this.refusedAt[0] ?? now) >= HOME_REFUSAL_WINDOW_MS) {
      this.refusedAt.shift();
    }
    this.refusedAt.push(now);
    if (this.refusedAt.length > HOME_MAX_REFUSALS) return { kind: 'close', reason: 'refusals' };
    // A refusal is a few hundred bytes, so it always encodes.
    return this.send(encodeRelayFrame(relayCallRefusalFrame(id, error))!)
      ? { kind: 'answered' }
      : { kind: 'close' };
  }

  private serve(id: string, call: RelayCall): void {
    const server = this.options.calls;
    if (!server) return;
    // A server that throws at once fails the one call, like one that rejects.
    Promise.resolve()
      .then(() => server.serve(call))
      .then(
        (body) => this.send(encodeRelayCallResultFrame(id, call.op, body)),
        () => this.send(encodeRelayFrame(relayCallRefusalFrame(id, CALL_FAILED))!)
      );
  }
}
