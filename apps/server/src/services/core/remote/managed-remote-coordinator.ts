/**
 * A person's side of managed remote access on this computer (DOR-2086): setting
 * it up, choosing it, closing it, and withdrawing from it. Cloud's side (open,
 * close, rotate and revoke commands over the instance's own stream) is the
 * command dispatcher's, and never runs through here.
 *
 * ## Setup is a person's approval, end to end
 *
 * {@link ManagedRemoteCoordinator.startEnrolment} runs only after the setup
 * route has seen a person at this computer (`routes/remote-access.ts`: the
 * cookie bar under login, the trusted-caller bar, the local-caller bar, and a
 * real login). It asks Cloud for an enrolment request, shows the person a code
 * and an approval page, and polls until a person answers there:
 *
 * - `approved` → the enrolment is saved, bound to this link's instance id and
 *   the consent version the person saw; then a credential is issued with a
 *   fresh idempotency key, its value and edge proof secret are stored encrypted,
 *   Cloud is told it was stored, and only then are the references, hostnames
 *   and edge header saved and managed mode selected. A credential without an
 *   edge proof is refused outright: nothing could tell a request through the
 *   managed edge from one that was not. A `conflict` on issue means the key was
 *   spent, and a fresh one is tried, as the contract says.
 * - `denied` and `expired` are states of their own, and a person may start
 *   again. A new request replaces a pending one, here as on Cloud.
 *
 * ## Every answer is checked against the link it was asked under
 *
 * An enrolment is only ever this link's when its recorded instance id is the
 * one the current link resolves (`isEnrolledUnder`). A record made under
 * another link is narrowed with `withdrawnRemoteState` as soon as the current
 * link's instance is known, and is never used meanwhile.
 *
 * Each setup captures the Cloud link (credential, origin and link generation,
 * through `captureCloudV1Context`) and a local epoch. Before it keeps any
 * answer it checks both are still current, so an unlink, a relink (even A →
 * unlink → A with the same key) or a withdrawal makes every later answer from
 * the old setup land nowhere. A stored secret whose setup went stale is
 * forgotten again, and nothing unconfirmed is ever referenced from config.
 *
 * ## Withdrawal is local first
 *
 * {@link ManagedRemoteCoordinator.withdraw} does everything local before its
 * first `await`: the command stream stops, any setup is cancelled, managed mode goes off, the enrolment
 * and credential references are cleared, and every managed listener starts
 * closing at once. The Cloud calls are sent in that same synchronous step with
 * the link captured before anything changed, so an unlink can call it first and
 * clear its key afterwards. What Cloud answers never undoes the local
 * withdrawal; when it cannot be reached the report says Cloud may still have a
 * record, and the calls are retried in memory with capped backoff and full
 * jitter while the same link stays current (`managed-cloud-cleanup.ts`). A
 * newer setup or withdrawal stops the retry, and so does the end of the link.
 *
 * Nothing here logs a secret: lines name ids and outcomes, never values.
 *
 * @module services/core/remote/managed-remote-coordinator
 */
import { randomUUID } from 'node:crypto';
import {
  RemoteCredentialConfirmResponseSchema,
  RemoteEnrolmentRequestSchema,
  RemoteEnrolmentRequestStatusSchema,
  V1_ROUTES,
  v1Path,
  type RemoteEnrolment,
  type RemoteEnrolmentRequest,
} from '@dork-labs/cloud-api';
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import type { RemoteAccessReport } from '@dorkos/shared/types';

import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';
import { tunnelManager } from '../tunnel-manager.js';
import {
  captureCloudV1Context,
  isAbsent,
  resolveCloudIdentity,
  type CloudIdentity,
  type CloudV1Context,
} from '../cloud/v1-client.js';
import { managedAvailability, type ManagedAvailability } from './managed-availability.js';
import { MANAGED_DRAIN_DEADLINE_MS } from './managed-ingress.js';
import { managedRemoteCommands, type ManagedCommandService } from './managed-command-service.js';
import { remoteCredentials, type RemoteCredentials } from './remote-credentials.js';
import { buildRemoteAccessReport, setupViewOf } from './remote-access-report.js';
import {
  abortableSleep,
  errorName,
  issueRemoteCredential,
  unreadable,
} from './managed-remote-support.js';
import {
  CLOUD_MAY_REMAIN_NOTE,
  MANAGED_REMOTE_ALREADY_SET_UP,
  MANAGED_REMOTE_NOT_SET_UP,
  SUPERSEDED,
  UNAVAILABLE,
  refusal,
  requestRefusal,
  type CoordinatorRefusal,
  type CoordinatorResult,
} from './managed-remote-refusals.js';
import { retryCloudCleanup, sendCloudCleanup, type OwedCleanup } from './managed-cloud-cleanup.js';
import {
  isEnrolledUnder,
  isForeignEnrolment,
  isRemoteEnrolmentActive,
  readRemoteState,
  updateRemoteState,
  clearedRemoteState,
  withdrawnRemoteState,
  type RemoteState,
} from './remote-state.js';

export * from './managed-remote-refusals.js';

/** The longest wait between two status reads after failures, before jitter. */
const MAX_POLL_BACKOFF_MS = 60_000;
/** The widest jitter added on top of the delay Cloud asked for. */
const POLL_JITTER_MS = 1_000;

/** What Cloud knows after a withdrawal. */
export type CloudCleanup = 'done' | 'may_remain';

/** What the coordinator touches, injectable for tests. */
export interface ManagedRemoteCoordinatorDeps {
  availability: Pick<ManagedAvailability, 'enabled' | 'read' | 'markAbsent' | 'invalidate'>;
  captureContext: () => CloudV1Context | null;
  resolveIdentity: (context: CloudV1Context) => Promise<CloudIdentity>;
  readRemoteState: () => RemoteState;
  updateRemoteState: (subsystem: string, patch: Partial<RemoteState>) => RemoteState;
  remoteCredentials: Pick<RemoteCredentials, 'put' | 'delete'>;
  /** The command stream: started once setup finishes, stopped on withdrawal. */
  commands: Pick<ManagedCommandService, 'start' | 'stop'>;
  tunnel: Pick<
    typeof tunnelManager,
    'status' | 'getMode' | 'getManagedPhase' | 'closeManaged' | 'stopOwnTunnel' | 'emit'
  >;
  /** Whether the person's own tunnel is set to open (`tunnel.enabled`). */
  ownTunnelEnabled: () => boolean;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
  newIdempotencyKey: () => string;
}

interface Setup {
  epoch: number;
  context: CloudV1Context;
  instanceId: string;
  request: RemoteEnrolmentRequest;
  controller: AbortController;
}

/** A person's managed remote access on this computer. See the module doc. */
export class ManagedRemoteCoordinator {
  /** Bumped by every new setup and every withdrawal; older work keeps nothing. */
  private epoch = 0;
  private setup: Setup | null = null;
  private outcome: 'denied' | 'expired' | null = null;
  private note: string | undefined;
  /** Set when Cloud said it already holds an enrolment this computer does not. */
  private cloudHoldsEnrolment = false;
  private work: Promise<void> | undefined;
  /** The Cloud cleanup retry in flight, aborted by any newer setup or withdrawal. */
  private cleanup: { controller: AbortController; work: Promise<void> } | undefined;

  /**
   * Build the coordinator.
   *
   * @param deps - Everything it touches; {@link managedRemoteCoordinator} wires the real ones.
   */
  constructor(private readonly deps: ManagedRemoteCoordinatorDeps) {}

  /** The setup work in flight, for tests that wait on it. Resolves, never rejects. */
  get settled(): Promise<void> {
    return this.work ?? Promise.resolve();
  }

  /** The Cloud cleanup retry in flight, for tests that wait on it. Resolves, never rejects. */
  get cleanupSettled(): Promise<void> {
    return this.cleanup?.work ?? Promise.resolve();
  }

  /** The report every remote access surface reads. Never throws. */
  async report(): Promise<RemoteAccessReport> {
    const availability = await this.deps.availability.read();
    this.forgetForeignEnrolment(availability.instanceId);
    return buildRemoteAccessReport({
      tunnel: this.deps.tunnel.status,
      liveMode: this.deps.tunnel.getMode(),
      managedPhase: this.deps.tunnel.getManagedPhase(),
      remote: this.deps.readRemoteState(),
      ownTunnelEnabled: this.deps.ownTunnelEnabled(),
      availability,
      setup: setupViewOf(this.setup?.request ?? null, this.outcome),
      note: this.note,
    });
  }

  /**
   * Start managed setup: ask Cloud for an enrolment request and wait for a
   * person to answer it. Replaces a setup already waiting. When this computer
   * is enrolled but holds no credential (an earlier setup stopped after the
   * approval), it resumes at the credential instead of asking again.
   *
   * The caller has already established a person at this computer; see the
   * module doc.
   */
  async startEnrolment(): Promise<CoordinatorResult> {
    if ((await this.deps.availability.read({ fresh: true })).availability !== 'available') {
      return UNAVAILABLE;
    }
    const context = this.deps.captureContext();
    if (context === null) return UNAVAILABLE;
    const epoch = this.beginEpoch();
    let instanceId: string | null;
    try {
      instanceId = (await this.deps.resolveIdentity(context)).instanceId;
    } catch {
      instanceId = null;
    }
    if (!this.isLive(epoch, context)) return SUPERSEDED;
    if (instanceId === null) return UNAVAILABLE;

    this.forgetForeignEnrolment(instanceId);
    const state = this.deps.readRemoteState();
    if (isEnrolledUnder(state, instanceId)) {
      if (state.credentialId !== null) {
        return refusal(
          409,
          MANAGED_REMOTE_ALREADY_SET_UP,
          'Remote access is already set up. Turn it off first to set it up again.'
        );
      }
      this.track(this.finishCredential(context, instanceId, epoch));
      this.notify();
      return { ok: true };
    }

    let request: RemoteEnrolmentRequest;
    try {
      request = await context.client.post(
        V1_ROUTES.remoteEnrolmentRequests,
        RemoteEnrolmentRequestSchema
      );
    } catch (error) {
      if (!this.isLive(epoch, context)) return SUPERSEDED;
      return this.requestRefused(error);
    }
    if (!this.isLive(epoch, context)) return SUPERSEDED;

    const setup: Setup = { epoch, context, instanceId, request, controller: new AbortController() };
    this.setup = setup;
    this.track(this.poll(setup));
    this.notify();
    return { ok: true };
  }

  /**
   * Record the mode a person chose. `managed` needs a finished setup and closes
   * the person's own tunnel, so the two never run together; `byo` and `off`
   * close managed access at once. Nothing opens here: managed access opens on a
   * Cloud `open` command, the person's own tunnel through its own route.
   *
   * @param mode - The person's choice.
   */
  async selectMode(mode: RemoteAccessMode): Promise<CoordinatorResult> {
    if (mode === 'managed') {
      if (!this.deps.availability.enabled) return UNAVAILABLE;
      const { availability, instanceId } = await this.deps.availability.read();
      if (availability !== 'available') return UNAVAILABLE;
      this.forgetForeignEnrolment(instanceId);
      const state = this.deps.readRemoteState();
      if (!isEnrolledUnder(state, instanceId) || state.credentialId === null) {
        return refusal(409, MANAGED_REMOTE_NOT_SET_UP, 'Set up remote access first.');
      }
      this.deps.updateRemoteState('choosing managed remote access', { mode });
      if (this.deps.tunnel.getMode() === 'byo') await this.deps.tunnel.stopOwnTunnel();
    } else {
      this.deps.updateRemoteState('choosing remote access', { mode });
      await this.deps.tunnel.closeManaged({ immediate: true });
    }
    this.note = undefined;
    this.notify();
    return { ok: true };
  }

  /**
   * Close managed access now. New requests are refused at once; requests
   * already admitted get {@link MANAGED_DRAIN_DEADLINE_MS} to finish, after
   * which the ingress cuts the rest. Changes no choice and no consent: Cloud
   * may open it again on a person's request.
   */
  close(): void {
    if (this.deps.tunnel.getManagedPhase() === null) return;
    void this.deps.tunnel
      .closeManaged({ immediate: false, drainDeadlineMs: MANAGED_DRAIN_DEADLINE_MS })
      .catch((error: unknown) => {
        logger.warn('[RemoteAccess] Managed close failed', { error: errorName(error) });
      });
  }

  /**
   * Withdraw managed remote access: local first and synchronous, then Cloud
   * best-effort with the link captured before anything changed. See the
   * module doc.
   *
   * @returns Resolves once Cloud answered or could not be reached; never rejects.
   */
  withdraw(): Promise<CloudCleanup> {
    // Everything up to the first `await` below is synchronous on purpose.
    const context = this.deps.captureContext();
    const before = this.deps.readRemoteState();
    const hadSetup = this.setup !== null;
    this.deps.commands.stop();
    const epoch = this.beginEpoch();
    this.outcome = null;
    this.note = undefined;
    try {
      this.deps.updateRemoteState('withdrawing managed remote access', clearedRemoteState(before));
    } catch (error) {
      logger.warn('[RemoteAccess] Could not clear the saved record', { error: errorName(error) });
    }
    const closing = this.deps.tunnel.closeManaged({ immediate: true }).catch((error: unknown) => {
      logger.warn('[RemoteAccess] Managed close failed', { error: errorName(error) });
    });
    const cloudHasSomething =
      before.enrolmentId !== null ||
      before.credentialId !== null ||
      hadSetup ||
      this.cloudHoldsEnrolment;
    // Ids only: a retry re-reads the key, and only under this same link.
    const owed: OwedCleanup | null = cloudHasSomething
      ? {
          instanceId: before.instanceId,
          credentialId: before.credentialId,
          revoke: true,
          forget: true,
        }
      : null;
    // Sent now, while the captured link's key is still the stored one.
    const cloudCalls = owed && context !== null ? sendCloudCleanup(context, owed) : undefined;
    this.refresh();

    return (async (): Promise<CloudCleanup> => {
      await closing;
      if (before.credentialId !== null) {
        await this.deps.remoteCredentials.delete(before.credentialId).catch(() => {
          logger.warn('[RemoteAccess] Could not forget the stored credential');
        });
      }
      const remaining = cloudCalls ? await cloudCalls.catch(() => owed) : owed;
      const cleanup: CloudCleanup = remaining === null ? 'done' : 'may_remain';
      if (cleanup === 'done') this.cloudHoldsEnrolment = false;
      this.note = cleanup === 'may_remain' ? CLOUD_MAY_REMAIN_NOTE : undefined;
      // With no link there is no key to ask with: the note stays, and that is all.
      if (remaining !== null && context !== null && epoch === this.epoch) {
        this.retryCleanup(remaining, context);
      }
      this.refresh();
      logger.info('[RemoteAccess] Managed remote access withdrawn', { cloud: cleanup });
      return cleanup;
    })();
  }

  /**
   * The unlink step: withdraw as a person would, when there is anything to
   * withdraw. Called by the account link before it clears its key, so the
   * Cloud calls go out under the old link.
   */
  withdrawOnUnlink(): Promise<CloudCleanup> {
    this.deps.commands.stop();
    const state = this.deps.readRemoteState();
    const anything =
      this.setup !== null ||
      isRemoteEnrolmentActive(state) ||
      state.credentialId !== null ||
      state.mode === 'managed' ||
      this.cloudHoldsEnrolment ||
      this.deps.tunnel.getManagedPhase() !== null;
    if (!anything) return Promise.resolve('done');
    return this.withdraw();
  }

  // ---------- setup ----------

  private beginEpoch(): number {
    this.epoch += 1;
    this.setup?.controller.abort();
    this.setup = null;
    // A newer setup or withdrawal owns what Cloud is told from here on.
    this.cleanup?.controller.abort();
    this.cleanup = undefined;
    return this.epoch;
  }

  /** Ask Cloud again later, while `context`'s link stays current. See the module doc. */
  private retryCleanup(owed: OwedCleanup, context: CloudV1Context): void {
    const controller = new AbortController();
    const work = retryCloudCleanup({
      owed,
      linkIsCurrent: () => context.isCurrent(),
      captureContext: this.deps.captureContext,
      sleep: this.deps.sleep,
      random: this.deps.random,
      signal: controller.signal,
    })
      .then((outcome) => {
        if (this.cleanup?.controller === controller) this.cleanup = undefined;
        if (outcome !== 'done') return;
        this.cloudHoldsEnrolment = false;
        if (this.note === CLOUD_MAY_REMAIN_NOTE) this.note = undefined;
        this.refresh();
        logger.info('[RemoteAccess] Cloud cleanup finished on a retry');
      })
      .catch(() => undefined);
    this.cleanup = { controller, work };
  }

  /**
   * Narrow a record whose enrolment was made under another link than the one
   * whose instance is `instanceId`: nothing under this link may use it. Keeps
   * what a later cleanup needs, as an unlink does. Never throws.
   */
  private forgetForeignEnrolment(instanceId: string | null): void {
    const state = this.deps.readRemoteState();
    if (!isForeignEnrolment(state, instanceId)) return;
    try {
      this.deps.updateRemoteState(
        'forgetting remote access set up under another link',
        withdrawnRemoteState(state)
      );
    } catch (error) {
      logger.warn('[RemoteAccess] Could not narrow the saved record', { error: errorName(error) });
    }
    if (this.deps.tunnel.getManagedPhase() !== null) {
      void this.deps.tunnel.closeManaged({ immediate: true }).catch(() => undefined);
    }
    logger.info('[RemoteAccess] Ignored an enrolment from another link');
  }

  private isLive(epoch: number, context: CloudV1Context): boolean {
    return epoch === this.epoch && context.isCurrent();
  }

  private requestRefused(error: unknown): CoordinatorRefusal {
    const { refusal: refused, absent, cloudHolds } = requestRefusal(error);
    if (absent) {
      this.deps.availability.markAbsent();
      this.notify();
    }
    if (cloudHolds) this.cloudHoldsEnrolment = true;
    return refused;
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      logger.warn('[RemoteAccess] Setup stopped', { error: errorName(error) });
    });
    this.work = tracked;
  }

  private async poll(setup: Setup): Promise<void> {
    let waitMs = setup.request.pollAfterMs;
    let expiresAt = setup.request.expiresAt;
    let failures = 0;
    const { context, request } = setup;
    for (;;) {
      await this.deps.sleep(this.delay(waitMs, failures), setup.controller.signal);
      if (!this.owns(setup)) return;
      if (this.deps.now() >= Date.parse(expiresAt)) return this.settle(setup, 'expired');
      let answer;
      try {
        answer = await context.client.get(
          v1Path.remoteEnrolmentRequest(request.requestId),
          RemoteEnrolmentRequestStatusSchema
        );
      } catch (error) {
        if (!this.owns(setup)) return;
        // A request Cloud no longer holds, or an answer this build cannot
        // read, ended without enrolment: the person may ask again.
        if (isAbsent(error) || unreadable(error)) return this.settle(setup, 'expired');
        failures += 1;
        continue;
      }
      if (!this.owns(setup)) return;
      failures = 0;
      switch (answer.status) {
        case 'pending':
          waitMs = answer.pollAfterMs;
          expiresAt = answer.expiresAt;
          continue;
        case 'denied':
        case 'expired':
          return this.settle(setup, answer.status);
        case 'approved':
          return this.approved(setup, answer.requestId, answer.enrolment);
      }
    }
  }

  /** Never sooner than Cloud asked; after failures, capped exponential backoff. Full jitter on top. */
  private delay(waitMs: number, failures: number): number {
    const base = failures === 0 ? waitMs : Math.min(MAX_POLL_BACKOFF_MS, waitMs * 2 ** failures);
    return base + Math.floor(this.deps.random() * Math.min(POLL_JITTER_MS, waitMs));
  }

  private owns(setup: Setup): boolean {
    return this.setup === setup && this.isLive(setup.epoch, setup.context);
  }

  private settle(setup: Setup, outcome: 'denied' | 'expired'): void {
    if (this.setup === setup) this.setup = null;
    this.outcome = outcome;
    this.notify();
  }

  private async approved(
    setup: Setup,
    requestId: string,
    enrolment: RemoteEnrolment
  ): Promise<void> {
    this.setup = null;
    this.outcome = null;
    if (
      requestId !== setup.request.requestId ||
      enrolment.consentVersion !== setup.request.consentVersion
    ) {
      // Not the request, or not the consent, the person was shown. Cloud may
      // hold an enrolment from it, so a withdrawal asks it to forget one.
      this.cloudHoldsEnrolment = true;
      logger.warn('[RemoteAccess] Approval did not match the request shown');
      return this.failed('DorkOS Cloud answered for a different setup. Start it again.');
    }
    this.cloudHoldsEnrolment = false;
    try {
      // The person chose managed access when they started setup here, so it
      // is selected with the consent. It reads `blocked` until a credential
      // is stored, and nothing opens from it either way.
      this.deps.updateRemoteState('managed remote setup', {
        mode: 'managed',
        enrolmentId: enrolment.enrolmentId,
        consentVersion: enrolment.consentVersion,
        instanceId: setup.instanceId,
      });
    } catch {
      return this.failed('The approval could not be saved on this computer. Try again.');
    }
    this.notify();
    await this.finishCredential(setup.context, setup.instanceId, setup.epoch);
  }

  /** Issue, store and confirm the credential, then save its references. */
  private async finishCredential(
    context: CloudV1Context,
    instanceId: string,
    epoch: number
  ): Promise<void> {
    const credential = await issueRemoteCredential(context, instanceId, {
      stillLive: () => this.isLive(epoch, context),
      newIdempotencyKey: this.deps.newIdempotencyKey,
    });
    if (credential === 'stale' || !this.isLive(epoch, context)) return;
    if (credential === null) {
      return this.failed('DorkOS Cloud could not issue a credential for this computer. Try again.');
    }
    const edgeProof = credential.edgeProof;
    if (!edgeProof) {
      // Cloud withdraws an issued credential nobody confirms.
      return this.failed(
        'DorkOS Cloud sent a credential this computer cannot check requests with.'
      );
    }

    let refs;
    try {
      refs = await this.deps.remoteCredentials.put({
        credentialId: credential.credentialId,
        value: credential.value,
        edgeProofSecret: edgeProof.secret,
      });
    } catch {
      return this.failed('The credential could not be stored on this computer. Try again.');
    }
    const forget = () =>
      this.deps.remoteCredentials.delete(credential.credentialId).catch(() => undefined);
    if (!this.isLive(epoch, context)) return void (await forget());

    try {
      const confirmed = await context.client.post(
        V1_ROUTES.remoteCredentialsConfirm,
        RemoteCredentialConfirmResponseSchema,
        { body: { credentialId: credential.credentialId } }
      );
      if (confirmed.credentialId !== credential.credentialId) throw new Error('mismatched id');
    } catch (error) {
      await forget();
      if (!this.isLive(epoch, context)) return;
      logger.warn('[RemoteAccess] Credential confirmation failed', { error: errorName(error) });
      return this.failed('DorkOS Cloud did not confirm the credential. Try again.');
    }
    if (!this.isLive(epoch, context)) return void (await forget());

    const previous = this.deps.readRemoteState();
    this.deps.updateRemoteState('managed remote setup', {
      mode: 'managed',
      credentialRef: refs.credentialRef,
      edgeProofRef: refs.edgeProofRef,
      credentialId: credential.credentialId,
      fingerprint: credential.fingerprint,
      hosts: credential.hosts ?? previous.hosts,
      edgeProofHeader: edgeProof.header,
    });
    if (previous.credentialId !== null && previous.credentialId !== credential.credentialId) {
      await this.deps.remoteCredentials.delete(previous.credentialId).catch(() => undefined);
    }
    // Managed is chosen now, so the person's own tunnel does not stay open beside it.
    if (this.deps.tunnel.getMode() === 'byo') await this.deps.tunnel.stopOwnTunnel();
    this.note = undefined;
    this.deps.availability.invalidate();
    this.notify();
    // Cloud's open, close, rotate and revoke arrive on it; nothing opens here.
    void this.deps.commands.start();
    logger.info('[RemoteAccess] Managed remote access set up', {
      credentialId: credential.credentialId,
      hosts: credential.hosts?.length ?? 0,
    });
  }

  private failed(note: string): void {
    this.note = note;
    this.notify();
  }

  /** Every surface refetches the report on a tunnel status event. */
  private notify(): void {
    this.deps.tunnel.emit('status_change', this.deps.tunnel.status);
  }

  /** Drop cached availability and tell every surface. A throwing listener is logged, never thrown. */
  private refresh(): void {
    try {
      this.deps.availability.invalidate();
      this.notify();
    } catch (error) {
      logger.warn('[RemoteAccess] A status listener failed', { error: errorName(error) });
    }
  }
}

/** The process's coordinator, over the live link, config, store and tunnel. */
export const managedRemoteCoordinator = new ManagedRemoteCoordinator({
  availability: managedAvailability,
  captureContext: captureCloudV1Context,
  resolveIdentity: resolveCloudIdentity,
  readRemoteState,
  updateRemoteState,
  remoteCredentials,
  commands: managedRemoteCommands,
  tunnel: tunnelManager,
  ownTunnelEnabled: () => configManager.get('tunnel')?.enabled === true,
  sleep: abortableSleep,
  random: Math.random,
  now: Date.now,
  newIdempotencyKey: randomUUID,
});
