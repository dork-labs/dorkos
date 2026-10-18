/**
 * A hub's half of linking a cloud agent computer (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md` §2): minting the
 * machine link code and handing it to Cloud, and deciding what a redeem of
 * one comes to. `routes/hub-link.ts` checks the request's signature and signs
 * the answer exactly as it does for a person's computer, then asks
 * {@link redeemAgentComputerCode} whether to store the computer.
 *
 * **How the computer is named.** Its relay id is its cloud computer id behind
 * the reserved `ac:` prefix (`agentComputerRelayId` in
 * `@dorkos/shared/session-relay-link`), so the redeem names the computer in
 * the field it already signs, and the hub reads the cloud id back out of it.
 * A cloud id that does not fit the relay's id grammar is refused when minting,
 * never rewritten, since a rewrite could map two computers onto one id.
 *
 * **A second redeem is a security event.** Cloud holds the code until the
 * computer reads it, so someone inside Cloud could redeem it first with a key
 * of their own; the contract accepts that risk (`AgentComputerAssignmentSchema`)
 * on the condition that the hub notices. It does, two ways: a code redeemed
 * again by a different key than spent it, and a code redeemed for a computer
 * already linked under a different key. Either way the hub cannot tell which
 * redeemer is the real computer, so it trusts neither: it unlinks the
 * computer (closing any live connection), records the event, logs a warning,
 * and mints a fresh code for Cloud to hand out. The same key redeeming again
 * is the same computer (only it can sign with that key) retrying after a lost
 * answer, and simply links again.
 *
 * Telling the person: the link flow has no notice of its own today (a Mac's
 * link is only audited), so the event is the audit row and the warning; a
 * notice in the app is a follow-up.
 *
 * @module services/core/hub-relay/agent-computer-link
 */
import {
  AgentComputerLinkCodeRequestSchema,
  v1Path,
  type AgentComputerLinkCodeRequest,
} from '@dork-labs/cloud-api';
import { agentComputerRelayId, type RelayLinkRequest } from '@dorkos/shared/session-relay-link';
import { z } from 'zod';
import { env } from '../../../env.js';
import { logger } from '../../../lib/logger.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { createCloudV1ClientFor } from '../cloud/v1-client.js';
import { agentComputerCodes, type AgentComputerCodeBook } from './agent-computer-codes.js';
import {
  LinkedComputerKeyMismatchError,
  readLinkedComputers,
  type LinkComputerInput,
  type LinkedComputer,
} from './computer-store.js';

/** How long handing a code to Cloud may take. */
export const AGENT_COMPUTER_CODE_HANDOFF_TIMEOUT_MS = 10_000;

/** What minting and redeeming read and call, injectable for tests. */
export interface AgentComputerLinkDeps {
  /** The code book. */
  codes: Pick<AgentComputerCodeBook, 'mint' | 'claim' | 'hasLiveCode'>;
  /** Hand a code to Cloud for one computer (`POST /v1/computers/{id}/link-code`). */
  handToCloud: (cloudComputerId: string, body: AgentComputerLinkCodeRequest) => Promise<void>;
  /** Every computer this hub serves. */
  readLinked: () => LinkedComputer[];
  /** Store the computer (and close a replaced connection). */
  link: (input: LinkComputerInput) => Promise<unknown>;
  /** Unlink a computer and close its connection. */
  unlink: (computerId: string) => Promise<boolean>;
}

/**
 * Hand a code to Cloud with this hub's own key (`DORKOS_HUB_INSTANCE_KEY`).
 * A hub with no key hands nothing over.
 */
async function liveHandToCloud(
  cloudComputerId: string,
  body: AgentComputerLinkCodeRequest
): Promise<void> {
  if (!env.DORKOS_HUB_INSTANCE_KEY) throw new Error('This hub holds no DorkOS Cloud key.');
  await createCloudV1ClientFor(env.DORKOS_HUB_INSTANCE_KEY).post(
    v1Path.computerLinkCode(cloudComputerId),
    z.undefined(),
    { body, signal: AbortSignal.timeout(AGENT_COMPUTER_CODE_HANDOFF_TIMEOUT_MS) }
  );
}

/**
 * The live hub's dependencies, given its link and unlink (from this folder's
 * `index.ts`, which also closes connections).
 *
 * @param link - Store a computer.
 * @param unlink - Forget a computer.
 */
export function liveAgentComputerLinkDeps(
  link: AgentComputerLinkDeps['link'],
  unlink: AgentComputerLinkDeps['unlink']
): AgentComputerLinkDeps {
  return {
    codes: agentComputerCodes,
    handToCloud: liveHandToCloud,
    readLinked: () => readLinkedComputers(),
    link,
    unlink,
  };
}

/**
 * Mint a link code for one of this hub's agent computers and hand it to
 * Cloud, which gives it to the computer once, in its assignment. A new code
 * replaces the computer's old one, here and at Cloud.
 *
 * Minting when the hub makes or starts a computer is part 5's job (the
 * forwarding runtime, DOR-2940): today the only callers are the second-redeem
 * rule here and {@link mintLinkCodeIfUnlinked}.
 *
 * @param cloudComputerId - The computer's id at Cloud.
 * @param deps - The book and the Cloud handoff; the live hub's by default.
 * @returns When the code stops working (epoch ms).
 * @throws When the id cannot be relayed, or the code could not reach Cloud.
 *   A code that did not reach Cloud stays in the book until it expires; it is
 *   harmless, since nobody else ever held it.
 */
export async function mintAgentComputerLinkCode(
  cloudComputerId: string,
  deps: Pick<AgentComputerLinkDeps, 'codes' | 'handToCloud'> = {
    codes: agentComputerCodes,
    handToCloud: liveHandToCloud,
  }
): Promise<{ expiresAt: number }> {
  if (agentComputerRelayId(cloudComputerId) === null) {
    throw new Error('That cloud computer id cannot be linked over the relay.');
  }
  const minted = await deps.codes.mint(cloudComputerId);
  const body = AgentComputerLinkCodeRequestSchema.parse({
    code: minted.code,
    expiresAt: new Date(minted.expiresAt).toISOString(),
  });
  await deps.handToCloud(cloudComputerId, body);
  return { expiresAt: minted.expiresAt };
}

/** What a redeem for an agent computer came to. */
export type AgentComputerRedeemOutcome =
  /** Stored: linked, or linked again by the same key. */
  | { kind: 'linked' }
  /** A wrong, expired or used code: the same answer as a person's computer gets. */
  | { kind: 'invalid' }
  /** Too many wrong codes lately. */
  | { kind: 'throttled' }
  /** A second redeem: the computer was unlinked and a new code minted. */
  | { kind: 'reset' }
  /** The hub serves as many computers as it can. */
  | { kind: 'limit' };

/** What deciding a redeem came to inside the book's lock, before any new code is minted. */
type Decided = AgentComputerRedeemOutcome | { kind: 'second-redeem'; reason: SecondRedeemReason };

type SecondRedeemReason = 'code_redeemed_twice' | 'already_linked_other_key';

/**
 * Decide a redeem the route has already checked the signature of. Spends the
 * code; see the module doc for the second-redeem rule.
 *
 * The decision and the store it leads to happen inside the code book's lock
 * (`AgentComputerCodeBook.claim`), so a second redeem racing the first is
 * decided after the first has stored its link, and unlinks it. Minting the
 * replacement code takes the book's lock again, so it waits until after.
 *
 * @param request - The verified link request.
 * @param cloudComputerId - The cloud id its relay id names.
 * @param deps - See {@link AgentComputerLinkDeps}.
 */
export async function redeemAgentComputerCode(
  request: RelayLinkRequest,
  cloudComputerId: string,
  deps: AgentComputerLinkDeps
): Promise<AgentComputerRedeemOutcome> {
  const decided = await deps.codes.claim<Decided>(
    cloudComputerId,
    request.code,
    request.computerKey,
    async (claim) => {
      if (claim.kind === 'invalid' || claim.kind === 'throttled') return claim;
      const existing = deps.readLinked().find((c) => c.computerId === request.computerId);
      if (claim.kind === 'spent') {
        if (claim.byKey !== request.computerKey) {
          return unlinkForSecondRedeem(request, deps, 'code_redeemed_twice');
        }
        // A retry by the computer that spent it: only valid while it is linked.
        if (!existing || existing.computerKey !== request.computerKey) return { kind: 'invalid' };
      }
      try {
        await deps.link({
          role: 'agent-computer',
          cloudComputerId,
          computerId: request.computerId,
          secretHash: request.secretHash,
          computerKey: request.computerKey,
          computerName: request.computerName,
        });
      } catch (error) {
        if (error instanceof LinkedComputerKeyMismatchError) {
          return unlinkForSecondRedeem(request, deps, 'already_linked_other_key');
        }
        logger.warn('[HubRelay] An agent computer could not be linked', {
          error: (error as Error).name,
        });
        return { kind: 'limit' };
      }
      return { kind: 'linked' };
    }
  );
  if (decided.kind !== 'second-redeem') return decided;
  try {
    await mintAgentComputerLinkCode(cloudComputerId, deps);
  } catch (error) {
    // The computer stays unlinked; `mintLinkCodeIfUnlinked` links it later.
    logger.warn('[HubRelay] A new link code for an agent computer could not reach Cloud', {
      error: (error as Error).name,
    });
  }
  return { kind: 'reset' };
}

/** Unlink, record and warn: see the module doc. The new code is minted by the caller. */
async function unlinkForSecondRedeem(
  request: RelayLinkRequest,
  deps: AgentComputerLinkDeps,
  reason: SecondRedeemReason
): Promise<Decided> {
  const unlinked = await deps.unlink(request.computerId);
  logger.warn('[HubRelay] An agent computer`s link code was redeemed twice; it was unlinked', {
    computerId: request.computerId,
    reason,
    unlinked,
  });
  recordAudit({
    action: 'hub.relay.agent-computer.second-redeem',
    operation: 'remove',
    outcome: 'refused',
    error: reason,
    target: { type: 'computer', id: request.computerId, name: request.computerName },
    summary: 'A cloud computer was unlinked for safety: its link code was used twice',
    source: { surface: 'relay' },
  });
  return { kind: 'second-redeem', reason };
}

/**
 * Mint and hand over a code for an agent computer that is not linked and has
 * no live code waiting, so a computer that lost its link (a lost answer
 * after its code expired, a second redeem whose new code never reached Cloud)
 * can link again. Does nothing for a computer that is linked or has a code.
 *
 * Nothing on the hub calls this yet: the hub does not know its computers
 * until the forwarding runtime and `worksOn` arrive (DOR-2940 part 5), which
 * call it when the hub makes or starts a computer, and before each start.
 *
 * @param cloudComputerId - The computer's id at Cloud.
 * @param deps - See {@link AgentComputerLinkDeps}.
 * @returns Whether a code was minted.
 */
export async function mintLinkCodeIfUnlinked(
  cloudComputerId: string,
  deps: Pick<AgentComputerLinkDeps, 'codes' | 'handToCloud' | 'readLinked'>
): Promise<boolean> {
  const relayId = agentComputerRelayId(cloudComputerId);
  if (relayId === null) throw new Error('That cloud computer id cannot be linked over the relay.');
  if (deps.readLinked().some((c) => c.computerId === relayId)) return false;
  if (await deps.codes.hasLiveCode(cloudComputerId)) return false;
  await mintAgentComputerLinkCode(cloudComputerId, deps);
  return true;
}
