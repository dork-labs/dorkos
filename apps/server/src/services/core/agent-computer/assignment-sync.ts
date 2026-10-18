/**
 * A cloud agent computer finds its hub and links to it (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md` §2): one read of
 * `GET /v1/agent-computers/self/assignment` with the computer's own instance
 * key, and what follows from it.
 *
 * - **Not linked, a code waiting:** redeem it at `<hubOrigin>/api/hub/link`
 *   the way a person's computer does (`redeemAtHub`), signed with this
 *   computer's own Ed25519 key (made on first use, kept in the data folder).
 *   The hub's key comes from the hub's own signed answer over TLS, never from
 *   Cloud. The answer must name the same owner and issuer the assignment does.
 *   Then pin the hub's key, origin and owner (`pin-store.ts`) and dial.
 * - **Linked:** keep dialing the pinned hub. A new code means the hub wants
 *   this computer to link again (it unlinked it after a second redeem, say),
 *   so it is redeemed with the same key, and the hub must answer with the key
 *   pinned. A new `hubOrigin` is followed only once it checks out as a public
 *   https origin and a handshake there proves the pinned key; the pin keeps
 *   the old origin until then.
 * - **A code is kept until it links or expires.** Cloud hands each code out
 *   once, so a redeem that failed or lost its answer is tried again on the
 *   next reads (the runner backs off, at most a minute apart) until the code's
 *   `expiresAt`. A retry with the same key after a lost answer is one the hub
 *   accepts (`agent-computer-link.ts`).
 * - **Never linked and no code:** wait for the next read.
 *
 * **Refusals stop this computer working, for the life of the process:** an
 * assignment naming a different owner or issuer than the one pinned (or first
 * seen, before a pin), a different computer than the one pinned, a cloud id
 * the relay cannot carry, a hub that names another owner in its answer, or a
 * hub that answers a relink with another key. The relay is closed, no
 * further reads are made, and the error is logged. A restart reads the same
 * assignment against the same pin and refuses again, so nothing is persisted
 * for it.
 *
 * A read that fails or does not parse changes nothing and is retried; a
 * computer that holds a pin still dials the hub it pinned meanwhile.
 *
 * @module services/core/agent-computer/assignment-sync
 */
import {
  AgentComputerAssignmentSchema,
  type AgentComputerAssignment,
  type RemoteCommandOutcome,
} from '@dork-labs/cloud-api';
import {
  agentComputerRelayId,
  type SessionRelayLinkRefusal,
} from '@dorkos/shared/session-relay-link';
import { logger } from '../../../lib/logger.js';
import type { RelayPin, RelayPinInput } from '../session-relay/pin-store.js';
import type { RedeemAtHubInput, RedeemAtHubResult } from '../session-relay/relay-link.js';

/** The name an agent computer links with, as the hub's owner sees it. */
export const AGENT_COMPUTER_LINK_NAME = 'Cloud computer';

/** Why an agent computer stopped working. */
export type AgentComputerRefusal =
  | 'computer-id-unrelayable'
  | 'different-owner'
  | 'different-computer'
  | 'pin-without-owner'
  | 'hub-names-different-owner'
  | 'different-hub-key';

/** What one read of the assignment came to. */
export type AgentComputerSyncOutcome =
  /** Not linked, and no code to link with yet. */
  | { kind: 'waiting'; pollAfterSeconds: number | null }
  /** Linked: the pinned hub is dialed. */
  | { kind: 'linked'; pollAfterSeconds: number | null }
  /** The read or the redeem failed; nothing changed. */
  | { kind: 'failed' }
  /** A fault: this computer stops working. */
  | { kind: 'refused'; reason: AgentComputerRefusal };

/** What a sync reads and calls, injectable for tests. */
export interface AgentComputerSyncDeps {
  /** Read the assignment, unchecked. Throws when the request fails. */
  readAssignment: () => Promise<unknown>;
  /** The relay pin, or `null` when there is none (or it cannot be read). */
  readPin: () => RelayPin | null;
  /** Save the relay pin. */
  writePin: (pin: RelayPinInput) => Promise<void>;
  /** Redeem a code at a hub and check its signed answer (`redeemAtHub`). */
  redeem: (input: RedeemAtHubInput) => Promise<RedeemAtHubResult>;
  /** Whether an origin is a public https one (`checkPublicHost`). */
  checkHost: (origin: string) => Promise<'ok' | 'not-public' | 'hub-unreachable'>;
  /** This computer's relay connection to its hub. */
  dialer: {
    dialNow(): RemoteCommandOutcome;
    dialAt(hubOrigin: string, onProved: () => void): RemoteCommandOutcome;
    close(): void;
  };
  /** The clock, for `pinnedAt` and a code's expiry. */
  now?: () => Date;
}

/**
 * Redeem failures after which the code is dropped rather than tried again:
 * the hub reset the link and mints a new code (`already-linked`), or the
 * origin is not one this computer sends a code to.
 */
const FINAL_REDEEM_FAILURES: ReadonlySet<SessionRelayLinkRefusal> = new Set([
  'already-linked',
  'not-public',
  'bad-code',
]);

/** The owner an assignment names. */
interface Owner {
  ownerAccountId: string;
  issuer: string;
}

/** One agent computer's link to its hub, kept current one read at a time. */
export class AgentComputerAssignmentSync {
  private refusal: AgentComputerRefusal | null = null;
  /** The owner the first read named, held until a pin records it. */
  private seenOwner: Owner | null = null;
  /** The last code Cloud handed over, kept until it links or expires. */
  private pending: { code: string; expiresAt: number } | null = null;

  /**
   * Hold the sync's dependencies.
   *
   * @param deps - See {@link AgentComputerSyncDeps}.
   */
  constructor(private readonly deps: AgentComputerSyncDeps) {}

  /** Why this computer stopped working, or `null` while it works. */
  get refused(): AgentComputerRefusal | null {
    return this.refusal;
  }

  /** Read the assignment once and act on it. Never throws. */
  async sync(): Promise<AgentComputerSyncOutcome> {
    if (this.refusal) return { kind: 'refused', reason: this.refusal };
    let read: unknown;
    try {
      read = await this.deps.readAssignment();
    } catch (error) {
      logger.warn('[AgentComputer] Could not read this computer`s assignment; trying again', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return this.failedKeepingPin();
    }
    const parsed = AgentComputerAssignmentSchema.safeParse(read);
    if (!parsed.success) {
      logger.warn('[AgentComputer] Could not understand this computer`s assignment');
      return this.failedKeepingPin();
    }
    try {
      return await this.apply(parsed.data);
    } catch (error) {
      logger.warn('[AgentComputer] Linking to the hub failed; trying again', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { kind: 'failed' };
    }
  }

  private async apply(assignment: AgentComputerAssignment): Promise<AgentComputerSyncOutcome> {
    const relayId = agentComputerRelayId(assignment.computerId);
    if (relayId === null) return this.refuse('computer-id-unrelayable');
    const owner: Owner = { ownerAccountId: assignment.ownerAccountId, issuer: assignment.issuer };
    const pin = this.deps.readPin();
    if (pin && (!pin.accountId || !pin.issuer)) return this.refuse('pin-without-owner');
    const pinned: Owner | null = pin
      ? { ownerAccountId: pin.accountId!, issuer: pin.issuer! }
      : this.seenOwner;
    if (pinned && !sameOwner(pinned, owner)) return this.refuse('different-owner');
    if (pin && pin.computerId !== relayId) return this.refuse('different-computer');
    this.seenOwner = owner;
    const pollAfterSeconds = assignment.pollAfterSeconds ?? null;
    // Cloud hands each code out once: keep it until it links or expires, so
    // a redeem whose answer was lost is tried again rather than stranded.
    if (assignment.linkCode) {
      this.pending = {
        code: assignment.linkCode.code,
        expiresAt: Date.parse(assignment.linkCode.expiresAt),
      };
    }
    if (this.pending && !(this.pending.expiresAt > this.nowMs())) this.pending = null;

    if (!pin) {
      if (!this.pending) return { kind: 'waiting', pollAfterSeconds };
      const linked = await this.link(assignment.hubOrigin, relayId, owner, null);
      if (linked !== 'linked') return linked;
      this.deps.dialer.dialNow();
      return { kind: 'linked', pollAfterSeconds };
    }

    // A relink writes the assignment's origin with the new secret.
    const relinked = this.pending
      ? await this.link(assignment.hubOrigin, relayId, owner, pin)
      : null;
    if (relinked !== null && relinked !== 'linked' && relinked.kind === 'refused') return relinked;
    if (relinked !== 'linked' && assignment.hubOrigin !== pin.hubOrigin) {
      await this.followMovedHub(pin, assignment.hubOrigin);
    } else {
      this.deps.dialer.dialNow();
    }
    // A relink still owed is retried soon, while its code lives.
    if (relinked !== null && relinked !== 'linked') return relinked;
    return { kind: 'linked', pollAfterSeconds };
  }

  /**
   * Cloud moved the hub's front door. The new origin must be a public https
   * one before anything is sent there, and it is saved only once a handshake
   * there has proved the pinned key ({@link AgentComputerSyncDeps.dialer}
   * `dialAt`); until then the pin keeps the old origin. A hub at the new
   * origin that signs with another key is refused by the handshake, and the
   * next read tries again.
   */
  private async followMovedHub(pin: RelayPin, hubOrigin: string): Promise<void> {
    const reach = await this.deps.checkHost(hubOrigin);
    if (reach !== 'ok') {
      logger.warn('[AgentComputer] The hub`s new address is not a public one; keeping the old', {
        reach,
      });
      this.deps.dialer.dialNow();
      return;
    }
    this.deps.dialer.close();
    this.deps.dialer.dialAt(hubOrigin, () => {
      const current = this.deps.readPin();
      // Only the pin this dial was made from: never one replaced meanwhile.
      if (!current || current.hubKey !== pin.hubKey || current.relaySecret !== pin.relaySecret) {
        return;
      }
      void this.deps.writePin({ ...current, hubOrigin }).then(
        () => logger.info('[AgentComputer] The hub moved; its new address is saved'),
        (error: unknown) =>
          logger.warn('[AgentComputer] Could not save the hub`s new address', {
            error: error instanceof Error ? error.name : 'unknown',
          })
      );
    });
  }

  /**
   * Redeem the code waiting and pin the hub. With a pin already, the hub must
   * answer with the pinned key, and the new secret replaces the old. A redeem
   * that failed keeps the code for the next try, unless the failure says the
   * code can never work: the hub reset the link (it mints a new code), or the
   * origin is not one this computer will send it to.
   */
  private async link(
    hubOrigin: string,
    relayId: string,
    owner: Owner,
    pin: RelayPin | null
  ): Promise<'linked' | AgentComputerSyncOutcome> {
    const redeemed = await this.deps.redeem({
      origin: hubOrigin,
      code: this.pending!.code,
      computerId: relayId,
      computerName: pin?.computerName ?? AGENT_COMPUTER_LINK_NAME,
    });
    if (!redeemed.ok) {
      logger.warn('[AgentComputer] The hub did not take this computer`s link code', {
        reason: redeemed.reason,
      });
      if (FINAL_REDEEM_FAILURES.has(redeemed.reason)) this.pending = null;
      return { kind: 'failed' };
    }
    this.pending = null;
    const { answer, relaySecret } = redeemed;
    if (answer.ownerAccountId !== owner.ownerAccountId || answer.issuer !== owner.issuer) {
      return this.refuse('hub-names-different-owner');
    }
    if (pin && answer.hubKey !== pin.hubKey) return this.refuse('different-hub-key');
    await this.deps.writePin({
      v: 2,
      computerId: relayId,
      hubOrigin,
      hubKey: answer.hubKey,
      relaySecret,
      pinnedAt: pin?.pinnedAt ?? new Date(this.nowMs()).toISOString(),
      computerName: pin?.computerName ?? AGENT_COMPUTER_LINK_NAME,
      level: 'chat',
      paused: false,
      issuer: owner.issuer,
      accountId: owner.ownerAccountId,
    });
    // A live connection was proved with the old secret; the hub dropped it too.
    if (pin) this.deps.dialer.close();
    logger.info('[AgentComputer] Linked to the hub');
    return 'linked';
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /**
   * A read that failed changes nothing: a computer that linked before (this
   * boot or an earlier one) still dials the hub it pinned, by its pinned key,
   * so a restart while Cloud is unreachable does not cut its agents off.
   */
  private failedKeepingPin(): AgentComputerSyncOutcome {
    if (this.deps.readPin()) this.deps.dialer.dialNow();
    return { kind: 'failed' };
  }

  private refuse(reason: AgentComputerRefusal): AgentComputerSyncOutcome {
    this.refusal = reason;
    this.deps.dialer.close();
    logger.error('[AgentComputer] Refused this computer`s assignment; it stops working', {
      reason,
    });
    return { kind: 'refused', reason };
  }
}

/** Whether two owners are the same account at the same issuer, compared exactly. */
function sameOwner(a: Owner, b: Owner): boolean {
  return a.ownerAccountId === b.ownerAccountId && a.issuer === b.issuer;
}
