/**
 * Cloud's side of managed remote access (DOR-2086): what this computer does
 * with each leased command read from the command stream. The one caller of
 * `mintCloudAuthority`, pinned by `capabilities/__tests__/gate-bypass-scan.test.ts`.
 *
 * ## Every command, in this order
 *
 * 1. **Journal first.** The command is written to the durable journal before
 *    anything acts on it (`command-journal.ts`). A command id seen before is
 *    never acted on again: it is answered with the outcome recorded the first
 *    time, under the lease token it arrived with now.
 * 2. **Mint.** `mintCloudAuthority` checks the command against the published
 *    schema, the verb against `open | close | rotate | revoke`, the lease, the
 *    link the stream was opened under, and the enrolment. A refusal is the
 *    outcome, as `refused:<reason>`: a withdrawn enrolment refuses an `open`
 *    even with the network down, because withdrawal clears it locally first.
 * 3. **Act, re-checking.** Each effect calls `isStillValid()` immediately
 *    before every protected call, because the link or the consent can end
 *    while an earlier step awaits. The effects still run the local rules: an
 *    open goes through `tunnelManager.startManaged`, which runs `canExpose()`
 *    and the edge-proof check itself. The authority proves who asked, not that
 *    the answer is yes.
 * 4. **Settle**, then hand the acknowledgement to the sender. A journal write
 *    that fails is retried, then held in memory (`command-settle.ts`), so the
 *    outcome that really happened is still acknowledged.
 *
 * Once {@link CommandDispatcher.halt} is called (at shutdown), nothing more is
 * journaled, and a command already under way is refused `refused:shutting-down`
 * at its next re-check, so no effect races the tunnel being torn down.
 *
 * Commands run one at a time, in the order they arrived. `inbox_pending`
 * carries no authority and this build has no seat path to signal, so it is
 * acknowledged `ignored`; `keepalive` never reaches here.
 *
 * Nothing here logs a value: lines name command ids, kinds and outcomes.
 *
 * @module services/core/remote/command-dispatcher
 */
import {
  RemoteAddressSchema,
  RemoteCredentialConfirmResponseSchema,
  RemoteCredentialSchema,
  V1_ROUTES,
  type RemoteCommand,
  type RemoteCommandOutcome,
  type RemoteCredential,
} from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import {
  isCloudAuthority,
  mintCloudAuthority,
  type CloudAuthority,
  type CloudAuthorityVerb,
} from '../capabilities/cloud-authority.js';
import type { CloudV1Context } from '../cloud/v1-client.js';
import { problemOf } from '../cloud/v1-client.js';
import type { ManagedStartRefusal } from './managed-forwarding.js';
import type { TunnelManager } from '../tunnel-manager.js';
import type { CommandJournal, PendingAck } from './command-journal.js';
import { CommandSettler } from './command-settle.js';
import { MANAGED_DRAIN_DEADLINE_MS } from './managed-ingress.js';
import { errorName } from './managed-remote-support.js';
import type { RemoteCredentials } from './remote-credentials.js';
import type { RemoteState } from './remote-state.js';

/** The longest drain a Cloud close may ask for; a longer one is cut to this. */
export const MAX_DRAIN_DEADLINE_MS = 10 * 60_000;

/** A leased command: every published kind but the keepalive. */
export type LeasedCommand = Exclude<RemoteCommand, { kind: 'keepalive' }>;

/** The link a command stream was opened under. */
export interface CommandLink {
  /** The captured link context; its client issues, confirms and resolves. */
  context: CloudV1Context;
  /** The Cloud instance id that link resolved when the stream opened. */
  instanceId: string;
}

/** What the dispatcher touches, injectable for tests. */
export interface CommandDispatcherDeps {
  journal: Pick<CommandJournal, 'record' | 'settle'>;
  tunnelManager: Pick<TunnelManager, 'startManaged' | 'closeManaged' | 'getManagedPhase'>;
  remoteCredentials: Pick<RemoteCredentials, 'put' | 'delete' | 'resolve'>;
  /** Called after each outcome is recorded, so the acknowledgement goes out. */
  onSettled: () => void;
  readRemoteState: () => RemoteState;
  /**
   * The `cloud.remote` writer. Called by this exact name, so the gate-bypass
   * scan sees every call.
   */
  updateRemoteState: (subsystem: string, patch: Partial<RemoteState>) => RemoteState;
}

/** How each refused open reads in an acknowledgement. */
const OPEN_REFUSALS: Record<ManagedStartRefusal, RemoteCommandOutcome> = {
  exposure_not_allowed: 'refused:exposure-not-allowed',
  edge_proof_missing: 'refused:no-edge-proof',
  no_hosts: 'refused:no-target',
  ingress_unavailable: 'refused:not-ready',
  byo_close_failed: 'failed',
  forward_failed: 'failed',
  superseded: 'failed',
};

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The hostname in an address Cloud gave (`host`, `host:port` or a URL), or `null`. */
export function hostnameOf(address: string | undefined): string | null {
  if (!address) return null;
  let host = address.trim().toLowerCase();
  try {
    if (host.includes('://')) host = new URL(host).hostname;
  } catch {
    return null;
  }
  host = host.split('/')[0]!.split(':')[0]!;
  return HOSTNAME.test(host) ? host : null;
}

/** Applies leased commands. One per process: see `managed-command-service.ts`. */
export class CommandDispatcher {
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by every open and switch; the managed session's generation. */
  private generation = 0;
  /** The drain deadline the latest applied open carried, in seconds. */
  private drainDeadlineSeconds: number | undefined;
  /** Set by {@link halt}: nothing more is journaled or acted on. */
  private halted = false;
  private readonly settler: CommandSettler;

  /**
   * Build the dispatcher.
   *
   * @param deps - The journal, the tunnel, the credential store and the ack hook.
   */
  constructor(private readonly deps: CommandDispatcherDeps) {
    this.settler = new CommandSettler(deps.journal);
  }

  /** Resolves once every command handed in so far has been dealt with. */
  get idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /**
   * Deal with one leased command, after every command handed in before it.
   *
   * @param command - The command, as parsed from the stream.
   * @param link - The link the stream was opened under.
   * @returns The recorded outcome, or `null` when it could not be journaled
   *   (then nothing acted, and Cloud redelivers it).
   */
  dispatch(command: LeasedCommand, link: CommandLink): Promise<RemoteCommandOutcome | null> {
    if (this.halted) return Promise.resolve(null);
    const run = this.chain.then(() => this.handle(command, link));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Refuse everything from now on: queued commands are not journaled (Cloud
   * redelivers them), and one under way is refused at its next re-check.
   * Called at shutdown, before the tunnel stops. Cannot be undone.
   */
  halt(): void {
    this.halted = true;
  }

  /**
   * Outcomes the journal would not take, owed to this link; see
   * `command-settle.ts`. The acknowledgement sender offers them first.
   *
   * @param instanceId - The link's instance id.
   */
  heldAcks(instanceId: string): PendingAck[] {
    return this.settler.pending(instanceId);
  }

  /**
   * Forget held outcomes whose acknowledgement is finished.
   *
   * @param items - The commands and the lease tokens their acknowledgement carried.
   */
  releaseHeld(items: ReadonlyArray<{ id: string; leaseToken: string }>): void {
    this.settler.release(items);
  }

  /** The authority is a real one, for this verb, still current, and not halted. */
  private stillValid(authority: CloudAuthority, verb: CloudAuthorityVerb): boolean {
    return !this.halted && isCloudAuthority(authority, verb) && authority.isStillValid();
  }

  /** Why a re-check failed: the shutdown, or the link or consent ending. */
  private refusal(): RemoteCommandOutcome {
    return this.halted ? 'refused:shutting-down' : 'refused:stale-link';
  }

  private async handle(
    command: LeasedCommand,
    link: CommandLink
  ): Promise<RemoteCommandOutcome | null> {
    if (this.halted) return null;
    let recorded;
    try {
      recorded = this.deps.journal.record({
        commandId: command.id,
        leaseToken: command.leaseToken,
        verb: command.kind,
        instanceId: link.instanceId,
      });
    } catch (error) {
      logger.warn('[RemoteAccess] Could not journal a command; not acting on it', {
        commandId: command.id,
        error: errorName(error),
      });
      return null;
    }
    if (recorded.kind === 'duplicate') {
      const outcome = recorded.outcome ?? this.settler.redelivered(command.id, command.leaseToken);
      if (outcome !== null) this.notifySettled();
      return outcome;
    }

    let outcome: RemoteCommandOutcome;
    try {
      outcome = await this.apply(command, link);
    } catch (error) {
      logger.warn('[RemoteAccess] A command failed', {
        commandId: command.id,
        kind: command.kind,
        error: errorName(error),
      });
      outcome = 'failed';
    }
    this.settler.settle(command, link.instanceId, outcome);
    this.notifySettled();
    logger.info('[RemoteAccess] Command settled', {
      commandId: command.id,
      kind: command.kind,
      outcome,
    });
    return outcome;
  }

  private notifySettled(): void {
    try {
      this.deps.onSettled();
    } catch (error) {
      logger.warn('[RemoteAccess] Could not hand an acknowledgement on', {
        error: errorName(error),
      });
    }
  }

  private async apply(command: LeasedCommand, link: CommandLink): Promise<RemoteCommandOutcome> {
    // A signal only: no authority, and no seat path in this build to wake.
    if (command.kind === 'inbox_pending') return 'ignored';
    const minted = mintCloudAuthority(command, {
      isCurrent: () => link.context.isCurrent(),
      instanceId: link.instanceId,
    });
    if (!minted.ok) return `refused:${minted.reason}`;
    const authority = minted.authority;
    switch (authority.verb) {
      case 'open':
        return this.open(authority, link);
      case 'close':
        return this.close(authority);
      case 'rotate':
        return this.rotate(authority, link);
      case 'revoke':
        return this.revoke(authority);
    }
  }

  // ---------- open ----------

  private async open(authority: CloudAuthority, link: CommandLink): Promise<RemoteCommandOutcome> {
    const command = authority.command;
    if (command.kind !== 'open' || !this.stillValid(authority, 'open')) return this.refusal();
    const state = this.deps.readRemoteState();
    const secrets = await this.deps.remoteCredentials.resolve(state);
    if (!secrets.ok) return `refused:${secrets.reason.replace(/_/g, '-')}`;
    if (state.edgeProofHeader === null) return 'refused:no-edge-proof';
    const hosts = state.hosts.length > 0 ? state.hosts : await this.addressOf(command, link);
    if (hosts.length === 0) return 'refused:no-target';

    if (!this.stillValid(authority, 'open')) return this.refusal();
    this.generation += 1;
    const result = await this.deps.tunnelManager.startManaged({
      value: secrets.value,
      hosts,
      edgeProof: { header: state.edgeProofHeader, secret: secrets.edgeProofSecret },
      generation: this.generation,
    });
    if (!result.ok) return OPEN_REFUSALS[result.reason];
    // Applied only when every host asked for is served.
    const served = new Set(result.hosts);
    if (!hosts.every((host) => served.has(host.toLowerCase()))) return 'failed';
    this.drainDeadlineSeconds = command.drainDeadlineSeconds;
    return 'applied';
  }

  /**
   * Where to open when the credential named no hostname: the command's own
   * address, else the canonical address Cloud publishes. Empty when neither.
   */
  private async addressOf(
    command: Extract<LeasedCommand, { kind: 'open' }>,
    link: CommandLink
  ): Promise<string[]> {
    const fromCommand = hostnameOf(command.address);
    if (fromCommand) return [fromCommand];
    try {
      const published = await link.context.client.get(V1_ROUTES.remoteAddress, RemoteAddressSchema);
      const host = hostnameOf(published.address);
      return host ? [host] : [];
    } catch (error) {
      logger.warn('[RemoteAccess] Could not read the published address', {
        error: problemOf(error)?.code ?? errorName(error),
      });
      return [];
    }
  }

  // ---------- close ----------

  private async close(authority: CloudAuthority): Promise<RemoteCommandOutcome> {
    if (!this.stillValid(authority, 'close')) return this.refusal();
    if (this.deps.tunnelManager.getManagedPhase() === null) return 'applied';
    const fromCloud = this.drainDeadlineSeconds;
    // Omitted when Cloud named none: the ingress then applies its own bounded
    // default, so there is one deadline and one place that enforces it.
    const drainDeadlineMs =
      fromCloud === undefined ? undefined : Math.min(MAX_DRAIN_DEADLINE_MS, fromCloud * 1000);
    logger.info('[RemoteAccess] Closing managed access', {
      commandId: authority.command.id,
      drainDeadline: fromCloud === undefined ? 'local default' : 'from DorkOS Cloud',
      drainDeadlineMs: drainDeadlineMs ?? MANAGED_DRAIN_DEADLINE_MS,
    });
    try {
      await this.deps.tunnelManager.closeManaged({ immediate: false, drainDeadlineMs });
      return 'applied';
    } catch (error) {
      logger.warn('[RemoteAccess] Managed close failed', { error: errorName(error) });
      return 'failed';
    }
  }

  // ---------- rotate ----------

  private async rotate(
    authority: CloudAuthority,
    link: CommandLink
  ): Promise<RemoteCommandOutcome> {
    const command = authority.command;
    if (command.kind !== 'rotate' || !this.stillValid(authority, 'rotate')) return this.refusal();
    let credential: RemoteCredential;
    try {
      // The command's `credentialId` is the issue key, as the contract directs.
      credential = await link.context.client.post(
        V1_ROUTES.remoteCredentialsIssue,
        RemoteCredentialSchema,
        { body: { instanceId: link.instanceId, idempotencyKey: command.credentialId } }
      );
    } catch (error) {
      // Refused: keep serving with the current credential.
      const code = problemOf(error)?.code;
      logger.warn('[RemoteAccess] Rotation issue refused', { code: code ?? errorName(error) });
      return code ? 'refused:issue-refused' : 'failed';
    }
    const previous = this.deps.readRemoteState();
    if (!credential.edgeProof) return 'refused:no-edge-proof';
    // Never store a replacement over the credential in use.
    if (credential.credentialId === previous.credentialId) return 'failed';

    if (!this.stillValid(authority, 'rotate')) return this.refusal();
    let refs;
    try {
      refs = await this.deps.remoteCredentials.put({
        credentialId: credential.credentialId,
        value: credential.value,
        edgeProofSecret: credential.edgeProof.secret,
      });
    } catch {
      return 'failed';
    }
    const forget = () =>
      this.deps.remoteCredentials.delete(credential.credentialId).catch(() => undefined);
    try {
      const confirmed = await link.context.client.post(
        V1_ROUTES.remoteCredentialsConfirm,
        RemoteCredentialConfirmResponseSchema,
        { body: { credentialId: credential.credentialId } }
      );
      if (confirmed.credentialId !== credential.credentialId) throw new Error('mismatched id');
    } catch (error) {
      await forget();
      logger.warn('[RemoteAccess] Rotation confirm failed', { error: errorName(error) });
      return 'failed';
    }
    // Switch only while the link and consent it was asked under still stand.
    if (!this.stillValid(authority, 'rotate')) {
      await forget();
      return this.refusal();
    }
    const next = this.deps.updateRemoteState('managed remote rotation', {
      credentialRef: refs.credentialRef,
      edgeProofRef: refs.edgeProofRef,
      credentialId: credential.credentialId,
      fingerprint: credential.fingerprint,
      hosts: credential.hosts ?? previous.hosts,
      edgeProofHeader: credential.edgeProof.header,
    });
    const outcome = await this.switchListener(authority, next);
    if (previous.credentialId !== null) {
      await this.deps.remoteCredentials.delete(previous.credentialId).catch(() => {
        logger.warn('[RemoteAccess] Could not forget the replaced credential');
      });
    }
    return outcome;
  }

  /**
   * Move an open managed session onto the confirmed replacement. The new
   * credential stays the stored one either way: it is confirmed, and the one
   * it replaced is revoked once the overlap passes. A failed switch leaves
   * managed access closed and says so; the next open uses the replacement.
   */
  private async switchListener(
    authority: CloudAuthority,
    next: RemoteState
  ): Promise<RemoteCommandOutcome> {
    if (this.deps.tunnelManager.getManagedPhase() !== 'open') return 'applied';
    if (!this.stillValid(authority, 'rotate')) return 'failed';
    const secrets = await this.deps.remoteCredentials.resolve(next);
    if (!secrets.ok || next.edgeProofHeader === null) return 'failed';
    if (!this.stillValid(authority, 'rotate')) return 'failed';
    this.generation += 1;
    const result = await this.deps.tunnelManager.startManaged({
      value: secrets.value,
      hosts: next.hosts,
      edgeProof: { header: next.edgeProofHeader, secret: secrets.edgeProofSecret },
      generation: this.generation,
    });
    if (!result.ok) {
      logger.warn('[RemoteAccess] Switching to the rotated credential failed', {
        reason: result.reason,
      });
      return 'failed';
    }
    return 'applied';
  }

  // ---------- revoke ----------

  private async revoke(authority: CloudAuthority): Promise<RemoteCommandOutcome> {
    const command = authority.command;
    if (command.kind !== 'revoke' || !this.stillValid(authority, 'revoke')) {
      return this.refusal();
    }
    const state = this.deps.readRemoteState();
    if (state.credentialId !== command.credentialId) {
      // Not the credential in use (a replaced one, say): forget any copy.
      await this.deps.remoteCredentials.delete(command.credentialId).catch(() => undefined);
      return 'ignored';
    }
    // Forgotten in config first, so nothing can resolve it again, even from
    // a stale reference; then closed at once (a revoke has no overlap).
    this.deps.updateRemoteState('revoking the managed remote credential', {
      credentialRef: null,
      edgeProofRef: null,
      credentialId: null,
      fingerprint: null,
      edgeProofHeader: null,
    });
    let outcome: RemoteCommandOutcome = 'applied';
    try {
      await this.deps.tunnelManager.closeManaged({ immediate: true });
    } catch (error) {
      logger.warn('[RemoteAccess] Managed close failed', { error: errorName(error) });
      outcome = 'failed';
    }
    await this.deps.remoteCredentials.delete(command.credentialId).catch(() => {
      logger.warn('[RemoteAccess] Could not forget the revoked credential');
    });
    return outcome;
  }
}
