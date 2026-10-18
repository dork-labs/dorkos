/**
 * Keeps a cloud agent computer linked to its hub (DOR-2940): reads its
 * assignment at boot, then again every `pollAfterSeconds` and at once when
 * Cloud sends `agent_computer_assignment_changed`, and owns the relay
 * connection the computer dials its hub over.
 *
 * - **The key.** Cloud boots the computer with its own instance key in
 *   `DORKOS_AGENT_COMPUTER_INSTANCE_KEY`, which `env.ts` reads once and
 *   removes from `process.env` before anything else starts, so no agent,
 *   terminal or MCP server this computer runs inherits it. It is presented to
 *   Cloud by this runner alone.
 * - **The beat.** Cloud's `pollAfterSeconds`, held between
 *   {@link AGENT_COMPUTER_MIN_POLL_MS} and {@link AGENT_COMPUTER_MAX_POLL_MS}
 *   so a bad value can neither spin nor stall it; without one, a minute while
 *   waiting for a code and five once linked. A failed read retries after
 *   {@link AGENT_COMPUTER_RETRY_MS}. A refusal stops the beat for good. Reads
 *   never overlap: one asked for while another runs follows it at once. The
 *   timer never holds the process open.
 * - **The connection.** The same relay dialer a person's computer uses, with
 *   two differences that belong to this role: it needs no owner account (the
 *   hub is this computer's only controller, and nobody signs in here), and it
 *   reads the pin directly rather than through the Chat-from-the-web switch,
 *   which is a person's setting. It dials after each read that finds it
 *   linked, and after a read that fails while it holds a pin. It
 *   advertises {@link AGENT_COMPUTER_RELAY_FEATURES}, which only this role
 *   reads; the agent computer's own operations join that list.
 *
 * @module services/core/agent-computer/assignment-runner
 */
import WebSocket from 'ws';
import { V1_ROUTES, type RemoteCommandOutcome } from '@dork-labs/cloud-api';
import type { RelayComputerFrame, RelayError, RelayWebFrame } from '@dorkos/shared/session-relay';
import { SESSION_RELAY_MAX_FRAME_LENGTH } from '@dorkos/shared/session-relay';
import { z } from 'zod';
import { env } from '../../../env.js';
import { logger } from '../../../lib/logger.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { createCloudV1ClientFor } from '../cloud/v1-client.js';
import { liveRelayDeps } from '../session-relay/live-deps.js';
import { computerSigningKey, readRelayPin, writeRelayPin } from '../session-relay/pin-store.js';
import {
  RelayDialer,
  type RelayRequestServer,
  type RelaySocket,
} from '../session-relay/relay-dialer.js';
import { redeemAtHub } from '../session-relay/relay-link.js';
import {
  RELAY_SERVED_FEATURES,
  SessionRelayRequestServer,
} from '../session-relay/relay-request-server.js';
import { sessionRelayWiring } from '../session-relay/index.js';
import {
  AgentComputerAssignmentSync,
  type AgentComputerSyncDeps,
  type AgentComputerSyncOutcome,
} from './assignment-sync.js';

/** The shortest wait between reads Cloud's `pollAfterSeconds` may ask for. */
export const AGENT_COMPUTER_MIN_POLL_MS = 5_000;

/** The longest wait between reads. */
export const AGENT_COMPUTER_MAX_POLL_MS = 60 * 60_000;

/** The wait while no code has come yet, when Cloud names none. */
export const AGENT_COMPUTER_WAITING_POLL_MS = 60_000;

/** The wait once linked, when Cloud names none. */
export const AGENT_COMPUTER_LINKED_POLL_MS = 5 * 60_000;

/** The wait after a failed read or redeem. */
export const AGENT_COMPUTER_RETRY_MS = 30_000;

/**
 * The relay features an agent computer advertises to its hub. Today they are
 * the ones a person's computer serves; the agent computer's own operations
 * (`agents.sync`, `turn.start` and the rest) join here, and only here.
 */
export const AGENT_COMPUTER_RELAY_FEATURES: readonly string[] = RELAY_SERVED_FEATURES;

/**
 * How long to wait after one read, or `null` to stop.
 *
 * @param outcome - What the read came to.
 */
export function nextAgentComputerPollMs(outcome: AgentComputerSyncOutcome): number | null {
  switch (outcome.kind) {
    case 'refused':
      return null;
    case 'failed':
      return AGENT_COMPUTER_RETRY_MS;
    case 'waiting':
    case 'linked': {
      const fallback =
        outcome.kind === 'waiting' ? AGENT_COMPUTER_WAITING_POLL_MS : AGENT_COMPUTER_LINKED_POLL_MS;
      const asked = outcome.pollAfterSeconds === null ? fallback : outcome.pollAfterSeconds * 1_000;
      return Math.min(AGENT_COMPUTER_MAX_POLL_MS, Math.max(AGENT_COMPUTER_MIN_POLL_MS, asked));
    }
  }
}

/** Reads an agent computer's assignment on a beat, and on demand. */
export class AgentComputerAssignmentRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private stopped = false;

  /**
   * Hold the sync it runs.
   *
   * @param sync - One read of the assignment.
   */
  constructor(private readonly sync: Pick<AgentComputerAssignmentSync, 'sync'>) {}

  /** Read now, then keep reading on the beat. */
  start(): void {
    void this.beat();
  }

  /**
   * Read again now: Cloud's `agent_computer_assignment_changed` command. A
   * read already running is followed by another at once.
   *
   * @returns The command's outcome: `applied`, or `ignored` once stopped.
   */
  readNow(): RemoteCommandOutcome {
    if (this.stopped) return 'ignored';
    if (this.running) {
      this.again = true;
      return 'applied';
    }
    this.clearTimer();
    void this.beat();
    return 'applied';
  }

  /** Stop reading. Cannot be undone. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    let outcome: AgentComputerSyncOutcome;
    try {
      outcome = await this.sync.sync();
    } catch {
      // `sync` never throws; this keeps the beat alive if it ever does.
      outcome = { kind: 'failed' };
    }
    this.running = false;
    const wait = nextAgentComputerPollMs(outcome);
    if (wait === null) {
      this.stop();
      return;
    }
    if (this.again) {
      this.again = false;
      void this.beat();
      return;
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.beat();
    }, wait);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The request server, advertising only this role's features. */
function agentComputerRequestServer(): RelayRequestServer {
  const inner = new SessionRelayRequestServer(liveRelayDeps(sessionRelayWiring));
  return {
    features: () => AGENT_COMPUTER_RELAY_FEATURES,
    handle: (frame: RelayWebFrame, emit: (frame: RelayComputerFrame) => void) =>
      inner.handle(frame, emit),
    closeAll: () => inner.closeAll(),
    endStream: (streamId: string, error: RelayError) => inner.endStream(streamId, error),
  };
}

/** The largest WebSocket message accepted: one sealed frame, with room for its JSON. */
const RELAY_MAX_SOCKET_PAYLOAD = SESSION_RELAY_MAX_FRAME_LENGTH + 4096;

let sync: AgentComputerAssignmentSync | null = null;
let dialer: RelayDialer | null = null;
let runner: AgentComputerAssignmentRunner | null = null;

/** This agent computer's relay dialer, made on first use. Never dials once refused. */
export function agentComputerDialer(): RelayDialer {
  dialer ??= new RelayDialer({
    readPin: () => (sync?.refused ? null : readRelayPin()),
    // The hub is this computer's only controller; no person signs in here.
    ownerExists: () => true,
    computerKey: () => computerSigningKey(),
    appVersion: SERVER_VERSION,
    server: agentComputerRequestServer(),
    connect: (url, headers) =>
      new WebSocket(url, {
        headers,
        maxPayload: RELAY_MAX_SOCKET_PAYLOAD,
        perMessageDeflate: false,
        // Never follow a redirect: the relay secret goes only to the pinned origin.
        followRedirects: false,
      }) as unknown as RelaySocket,
  });
  return dialer;
}

/**
 * The live sync's dependencies: Cloud through this computer's own key, the
 * relay pin in the data folder, and the live dialer.
 *
 * @param instanceKey - This computer's instance key.
 */
export function liveAgentComputerSyncDeps(instanceKey: string): AgentComputerSyncDeps {
  const client = createCloudV1ClientFor(instanceKey);
  return {
    readAssignment: () => client.get(V1_ROUTES.agentComputerAssignment, z.unknown()),
    readPin: () => readRelayPin(),
    writePin: (pin) => writeRelayPin(pin),
    redeem: (input) => redeemAtHub(input),
    dialer: agentComputerDialer(),
  };
}

/**
 * Start keeping this agent computer linked: read its assignment now and on
 * the beat, and dial the hub it pinned. Call once, on an agent computer only.
 *
 * @param deps - Replaces the live dependencies, for tests.
 */
export function startAgentComputerLink(deps?: AgentComputerSyncDeps): void {
  if (runner) return;
  const resolved =
    deps ??
    (env.DORKOS_AGENT_COMPUTER_INSTANCE_KEY
      ? liveAgentComputerSyncDeps(env.DORKOS_AGENT_COMPUTER_INSTANCE_KEY)
      : null);
  if (!resolved) {
    // `env.ts` refuses to boot an agent computer without its key; this is a backstop.
    logger.error('[AgentComputer] No instance key; this computer cannot find its hub');
    return;
  }
  sync = new AgentComputerAssignmentSync(resolved);
  runner = new AgentComputerAssignmentRunner(sync);
  runner.start();
}

/**
 * Cloud said this computer's assignment changed: read it now. `ignored` when
 * the link was never started (any other role) or has stopped.
 */
export function agentComputerAssignmentChanged(): RemoteCommandOutcome {
  return runner?.readNow() ?? 'ignored';
}

/** Stop reading and close the relay. At shutdown. */
export function stopAgentComputerLink(): void {
  runner?.stop();
  dialer?.close();
}
