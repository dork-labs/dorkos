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
 * first `await`: any setup is cancelled, managed mode goes off, the enrolment
 * and credential references are cleared, and every managed listener starts
 * closing at once. The Cloud calls are sent in that same synchronous step with
 * the link captured before anything changed, so an unlink can call it first and
 * clear its key afterwards. What Cloud answers never undoes the local
 * withdrawal; when it cannot be reached the report says Cloud may still have a
 * record.
 *
 * Nothing here logs a secret: lines name ids and outcomes, never values.
 *
 * @module services/core/remote/managed-remote-coordinator
 */
import { randomUUID } from 'node:crypto';
import {
  RemoteCredentialConfirmResponseSchema,
  RemoteCredentialRevokeResponseSchema,
  RemoteCredentialSchema,
  RemoteEnrolmentRequestSchema,
  RemoteEnrolmentRequestStatusSchema,
  RemoteEnrolmentWithdrawnSchema,
  V1_ROUTES,
  v1Path,
  type RemoteCredential,
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
  problemOf,
  resolveCloudIdentity,
  type CloudIdentity,
  type CloudV1Context,
} from '../cloud/v1-client.js';
import { managedAvailability, type ManagedAvailability } from './managed-availability.js';
import { remoteCredentials, type RemoteCredentials } from './remote-credentials.js';
import { buildRemoteAccessReport, type SetupView } from './remote-access-report.js';
import { abortableSleep, errorName, unreadable } from './managed-remote-support.js';
import {
  isRemoteEnrolmentActive,
  readRemoteState,
  updateRemoteState,
  type RemoteState,
} from './remote-state.js';

/** How many fresh idempotency keys one setup tries when Cloud answers `conflict`. */
const MAX_ISSUE_ATTEMPTS = 3;
/** The longest wait between two status reads after failures, before jitter. */
const MAX_POLL_BACKOFF_MS = 60_000;
/** The widest jitter added on top of the delay Cloud asked for. */
const POLL_JITTER_MS = 1_000;
/** How long a person's close lets admitted requests finish before cutting them. */
export const LOCAL_DRAIN_DEADLINE_MS = 30_000;

/** A refusal the routes answer with. Never carries a secret or a supplier detail. */
export interface CoordinatorRefusal {
  ok: false;
  status: number;
  code: string;
  error: string;
}

/** What a setup or mode action returns. */
export type CoordinatorResult = { ok: true } | CoordinatorRefusal;

/** What Cloud knows after a withdrawal. */
export type CloudCleanup = 'done' | 'may_remain';

/** Refusal codes the routes and the client match on. */
export const MANAGED_REMOTE_UNAVAILABLE = 'MANAGED_REMOTE_UNAVAILABLE';
export const MANAGED_REMOTE_ALREADY_SET_UP = 'MANAGED_REMOTE_ALREADY_SET_UP';
export const MANAGED_REMOTE_NOT_SET_UP = 'MANAGED_REMOTE_NOT_SET_UP';
export const MANAGED_REMOTE_SETUP_FAILED = 'MANAGED_REMOTE_SETUP_FAILED';

/** The note shown once a withdrawal could not reach Cloud. */
export const CLOUD_MAY_REMAIN_NOTE =
  'Turned off here. DorkOS Cloud may still have a record of this computer.';

/** What the coordinator touches, injectable for tests. */
export interface ManagedRemoteCoordinatorDeps {
  availability: Pick<ManagedAvailability, 'enabled' | 'read' | 'markAbsent' | 'invalidate'>;
  captureContext: () => CloudV1Context | null;
  resolveIdentity: (context: CloudV1Context) => Promise<CloudIdentity>;
  readRemoteState: () => RemoteState;
  updateRemoteState: (subsystem: string, patch: Partial<RemoteState>) => RemoteState;
  remoteCredentials: Pick<RemoteCredentials, 'put' | 'delete'>;
  tunnel: Pick<
    typeof tunnelManager,
    'status' | 'getMode' | 'getManagedPhase' | 'closeManaged' | 'stop' | 'emit'
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

function refusal(status: number, code: string, error: string): CoordinatorRefusal {
  return { ok: false, status, code, error };
}

const UNAVAILABLE = refusal(
  409,
  MANAGED_REMOTE_UNAVAILABLE,
  'DorkOS remote access is not available on this computer right now.'
);

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

  /** The report every remote access surface reads. Never throws. */
  async report(): Promise<RemoteAccessReport> {
    const availability = await this.deps.availability.read();
    return buildRemoteAccessReport({
      tunnel: this.deps.tunnel.status,
      liveMode: this.deps.tunnel.getMode(),
      managedPhase: this.deps.tunnel.getManagedPhase(),
      remote: this.deps.readRemoteState(),
      ownTunnelEnabled: this.deps.ownTunnelEnabled(),
      availability,
      setup: this.setupView(),
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
    if (!this.isLive(epoch, context)) return this.superseded();
    if (instanceId === null) return UNAVAILABLE;

    const state = this.deps.readRemoteState();
    if (isRemoteEnrolmentActive(state) && state.instanceId === instanceId) {
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
      if (!this.isLive(epoch, context)) return this.superseded();
      return this.requestRefused(error);
    }
    if (!this.isLive(epoch, context)) return this.superseded();

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
    const state = this.deps.readRemoteState();
    if (mode === 'managed') {
      if (!this.deps.availability.enabled) return UNAVAILABLE;
      if (!isRemoteEnrolmentActive(state) || state.credentialId === null) {
        return refusal(409, MANAGED_REMOTE_NOT_SET_UP, 'Set up remote access first.');
      }
      this.deps.updateRemoteState('choosing managed remote access', { mode });
      if (this.deps.tunnel.getMode() === 'byo') await this.deps.tunnel.stop();
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
   * already admitted get {@link LOCAL_DRAIN_DEADLINE_MS} to finish. Changes no
   * choice and no consent: Cloud may open it again on a person's request.
   */
  close(): void {
    if (this.deps.tunnel.getManagedPhase() === null) return;
    const gentle = this.deps.tunnel.closeManaged({ immediate: false });
    const deadline = setTimeout(() => {
      void this.deps.tunnel.closeManaged({ immediate: true }).catch(() => undefined);
    }, LOCAL_DRAIN_DEADLINE_MS);
    deadline.unref?.();
    void gentle
      .catch((error: unknown) => {
        logger.warn('[RemoteAccess] Managed close failed', { error: errorName(error) });
      })
      .finally(() => clearTimeout(deadline));
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
    this.beginEpoch();
    this.outcome = null;
    this.note = undefined;
    try {
      this.deps.updateRemoteState('withdrawing managed remote access', {
        mode: before.mode === 'managed' ? 'off' : before.mode,
        enrolmentId: null,
        consentVersion: null,
        instanceId: null,
        credentialRef: null,
        credentialId: null,
        fingerprint: null,
        hosts: [],
        edgeProofRef: null,
        edgeProofHeader: null,
      });
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
    // Sent now, while the captured link's key is still the stored one.
    const cloudCalls =
      cloudHasSomething && context !== null
        ? Promise.allSettled([
            context.client.post(
              V1_ROUTES.remoteCredentialsRevoke,
              RemoteCredentialRevokeResponseSchema
            ),
            context.client.delete(V1_ROUTES.remoteEnrolment, RemoteEnrolmentWithdrawnSchema),
          ])
        : undefined;
    this.notify();

    return (async (): Promise<CloudCleanup> => {
      await closing;
      if (before.credentialId !== null) {
        await this.deps.remoteCredentials.delete(before.credentialId).catch(() => {
          logger.warn('[RemoteAccess] Could not forget the stored credential');
        });
      }
      let cleanup: CloudCleanup = 'done';
      if (cloudHasSomething) {
        const results = cloudCalls ? await cloudCalls : undefined;
        const [revoked, deleted] = results ?? [];
        const deleteDone =
          deleted?.status === 'fulfilled' ||
          (deleted?.status === 'rejected' && isAbsent(deleted.reason));
        cleanup = revoked?.status === 'fulfilled' && deleteDone ? 'done' : 'may_remain';
      }
      if (cleanup === 'done') this.cloudHoldsEnrolment = false;
      this.note = cleanup === 'may_remain' ? CLOUD_MAY_REMAIN_NOTE : undefined;
      this.deps.availability.invalidate();
      this.notify();
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
    const state = this.deps.readRemoteState();
    const anything =
      this.setup !== null ||
      isRemoteEnrolmentActive(state) ||
      state.credentialId !== null ||
      state.mode === 'managed' ||
      this.deps.tunnel.getManagedPhase() !== null;
    if (!anything) return Promise.resolve('done');
    return this.withdraw();
  }

  // ---------- setup ----------

  private beginEpoch(): number {
    this.epoch += 1;
    this.setup?.controller.abort();
    this.setup = null;
    return this.epoch;
  }

  private isLive(epoch: number, context: CloudV1Context): boolean {
    return epoch === this.epoch && context.isCurrent();
  }

  private superseded(): CoordinatorRefusal {
    return refusal(409, MANAGED_REMOTE_UNAVAILABLE, 'Setup was cancelled before Cloud answered.');
  }

  private requestRefused(error: unknown): CoordinatorRefusal {
    if (isAbsent(error)) {
      this.deps.availability.markAbsent();
      this.notify();
      return UNAVAILABLE;
    }
    const code = problemOf(error)?.code;
    if (code === 'conflict') {
      this.cloudHoldsEnrolment = true;
      return refusal(
        409,
        MANAGED_REMOTE_ALREADY_SET_UP,
        'DorkOS Cloud already has this computer set up. Turn remote access off, then try again.'
      );
    }
    if (code === 'entitlement_required') {
      return refusal(
        409,
        MANAGED_REMOTE_UNAVAILABLE,
        'This account cannot use DorkOS remote access.'
      );
    }
    logger.warn('[RemoteAccess] Enrolment request refused', { code: code ?? errorName(error) });
    return refusal(
      502,
      MANAGED_REMOTE_SETUP_FAILED,
      'DorkOS Cloud could not start setup. Try again.'
    );
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
          return this.approved(setup, answer.enrolment);
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

  private async approved(setup: Setup, enrolment: RemoteEnrolment): Promise<void> {
    this.setup = null;
    this.outcome = null;
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
    const credential = await this.issue(context, instanceId, epoch);
    if (credential === null || !this.isLive(epoch, context)) return;
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
    if (this.deps.tunnel.getMode() === 'byo') await this.deps.tunnel.stop();
    this.note = undefined;
    this.deps.availability.invalidate();
    this.notify();
    logger.info('[RemoteAccess] Managed remote access set up', {
      credentialId: credential.credentialId,
      hosts: credential.hosts?.length ?? 0,
    });
  }

  /** Ask for a credential, with a fresh key per attempt. `null` when it could not be had. */
  private async issue(
    context: CloudV1Context,
    instanceId: string,
    epoch: number
  ): Promise<RemoteCredential | null> {
    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      // Chosen before the call and never reused: a key Cloud has seen is
      // refused with `conflict`, never answered twice, so after any lost or
      // refused answer the only recovery is a new key.
      const idempotencyKey = this.deps.newIdempotencyKey();
      try {
        return await context.client.post(V1_ROUTES.remoteCredentialsIssue, RemoteCredentialSchema, {
          body: { instanceId, idempotencyKey },
        });
      } catch (error) {
        if (!this.isLive(epoch, context)) return null;
        if (problemOf(error)?.code === 'conflict') continue;
        logger.warn('[RemoteAccess] Credential issue refused', {
          code: problemOf(error)?.code ?? errorName(error),
        });
        break;
      }
    }
    this.failed('DorkOS Cloud could not issue a credential for this computer. Try again.');
    return null;
  }

  private failed(note: string): void {
    this.note = note;
    this.notify();
  }

  private setupView(): SetupView {
    const setup = this.setup;
    if (setup) {
      return {
        status: 'pending',
        userCode: setup.request.userCode,
        approveUrl: setup.request.approveUrl,
        expiresAt: setup.request.expiresAt,
      };
    }
    return this.outcome ? { status: this.outcome } : null;
  }

  /** Every surface refetches the report on a tunnel status event. */
  private notify(): void {
    this.deps.tunnel.emit('status_change', this.deps.tunnel.status);
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
  tunnel: tunnelManager,
  ownTunnelEnabled: () => configManager.get('tunnel')?.enabled === true,
  sleep: abortableSleep,
  random: Math.random,
  now: Date.now,
  newIdempotencyKey: randomUUID,
});
