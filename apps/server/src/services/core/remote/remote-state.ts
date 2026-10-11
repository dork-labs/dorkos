/**
 * The one writer of `cloud.remote`, the managed remote access record (DOR-2086).
 *
 * The record is a person's consent (the enrolment Cloud holds for this
 * computer), the mode they selected, and references to the stored credential
 * and edge proof. Those facts only make sense together — a `managed` mode with
 * no enrolment behind it is a selection nobody consented to, and a credential
 * reference with no credential id cannot be revoked by name — so exactly one
 * module writes them, and it validates the whole record on every write. The
 * other writes are the unlink and a relink in `auth/cloud-link.ts`, which only
 * ever narrow the record, using {@link withdrawnRemoteState} from here.
 *
 * ## Who reaches the writer
 *
 * {@link updateRemoteState} is a protected effect in
 * `capabilities/__tests__/gate-bypass-scan.test.ts`: its callers are pinned
 * there, each with the gate in front of it (the local enrolment and withdrawal
 * routes' cookie, trusted-caller and local-caller bars; a Cloud command's
 * `CloudAuthority`). The general config door refuses the block outright
 * (`USE_REMOTE_ACCESS_API` in `operator/config-write.ts`), so this module is
 * the only way in.
 *
 * ## What it never does
 *
 * It never reads or writes `tunnel.*`: the person's own ngrok setup stays
 * exactly where they left it, and no BYO token is ever copied here. It never
 * holds a secret: the references it stores are produced by
 * `remote-credentials.ts`, and a raw value fails the schema's reference pattern
 * before it can reach the file. Its log line names paths, never values.
 *
 * @module services/core/remote/remote-state
 */
import { RemoteEdgeProofSchema } from '@dork-labs/cloud-api';
import {
  RemoteAccessSettingsSchema,
  defaultRemoteAccessSettings,
  type RemoteAccessSettings,
} from '@dorkos/shared/config-schema';

import { configManager } from '../config-manager.js';
import { logConfigWrite } from '../operator/config-write.js';

/** The `cloud.remote` record, as this computer holds it. */
export type RemoteState = RemoteAccessSettings;

/**
 * Read the current `cloud.remote` record, filled from defaults where a field is
 * absent (a config the migration has not reached yet reads as off and empty).
 *
 * @returns A fresh copy; mutating it changes nothing.
 */
export function readRemoteState(): RemoteState {
  const stored = configManager.get('cloud')?.remote;
  const parsed = RemoteAccessSettingsSchema.safeParse(stored ?? {});
  // A record this build cannot read is treated as no record at all: nothing
  // managed opens from it, and the next write replaces it whole.
  return parsed.success ? structuredClone(parsed.data) : defaultRemoteAccessSettings();
}

/**
 * Whether a person's enrolment is in place on this computer: Cloud recorded
 * their approval under a link this computer still names, and it has not been
 * withdrawn here.
 *
 * Consent, not reachability. An enrolled computer may be closed, and is never
 * opened by this fact alone. Whether the enrolment belongs to the CURRENT link
 * is a separate question, answered by comparing {@link RemoteState.instanceId}
 * with the instance id a command's link context resolved.
 *
 * @param state - The record to read; defaults to the current one.
 */
export function isRemoteEnrolmentActive(state: RemoteState = readRemoteState()): boolean {
  return state.enrolmentId !== null && state.consentVersion !== null && state.instanceId !== null;
}

/**
 * Whether the record's enrolment belongs to the link whose instance id is
 * `instanceId`: active, and bound to that same instance. An enrolment recorded
 * under another link (or when the current link's instance is not known) is not
 * one this link may act on, and reads as not enrolled.
 *
 * @param state - The record to read.
 * @param instanceId - The instance id the current link resolved, or `null`.
 */
export function isEnrolledUnder(state: RemoteState, instanceId: string | null): boolean {
  return isRemoteEnrolmentActive(state) && instanceId !== null && state.instanceId === instanceId;
}

/**
 * Whether the record holds an enrolment from a different link than the one
 * whose instance id is `instanceId`: one to narrow with
 * {@link withdrawnRemoteState}, since nothing under this link may use it.
 * `false` when the current instance is not known: no guess either way.
 *
 * @param state - The record to read.
 * @param instanceId - The instance id the current link resolved, or `null`.
 */
export function isForeignEnrolment(state: RemoteState, instanceId: string | null): boolean {
  return isRemoteEnrolmentActive(state) && instanceId !== null && state.instanceId !== instanceId;
}

/**
 * The record as it stands once this computer's link ends: managed access off,
 * and the enrolment and its link binding gone, so no later link can act on a
 * consent given under this one.
 *
 * Kept on purpose: the credential id, its references, fingerprint, hosts and
 * edge header. They are what a best-effort revoke and the stored-secret cleanup
 * need afterwards, and without an enrolment nothing can open with them.
 *
 * Pure. The unlink path (`auth/cloud-link.ts`) writes the result as part of
 * the one `cloud` write that clears the link, so the two can never disagree.
 *
 * @param state - The record before the link ended.
 * @returns The narrowed copy.
 */
export function withdrawnRemoteState(state: RemoteState | undefined): RemoteState {
  const parsed = RemoteAccessSettingsSchema.safeParse(state ?? {});
  const base = parsed.success ? parsed.data : defaultRemoteAccessSettings();
  return {
    ...structuredClone(base),
    mode: base.mode === 'managed' ? 'off' : base.mode,
    enrolmentId: null,
    consentVersion: null,
    instanceId: null,
  };
}

/**
 * The `cloud` section a newly saved key starts from. A key that replaces a
 * different one held right now (a relink while linked, to this account or
 * another) is a new link, so the record is narrowed with
 * {@link withdrawnRemoteState} exactly as an unlink narrows it: no consent
 * given under the old link survives into the new one, whichever account and
 * instance id it turns out to have. A first link, or the same key saved again,
 * changes nothing.
 *
 * Pure. `auth/cloud-link.ts` writes the result in the same `cloud` write that
 * saves the key, so the two can never disagree.
 *
 * @param cloud - The `cloud` section before the key is saved.
 * @param instanceToken - The key about to be saved.
 */
export function withRemoteForNewKey<
  T extends { instanceToken?: string | null; remote?: RemoteState },
>(cloud: T, instanceToken: string): T {
  const held = cloud.instanceToken;
  if (!held || held === instanceToken) return cloud;
  return { ...cloud, remote: withdrawnRemoteState(cloud.remote) };
}

/**
 * The record as it stands once a person withdraws here: everything
 * {@link withdrawnRemoteState} clears, and the credential, its references,
 * fingerprint, hosts and edge header too, since withdrawal forgets the stored
 * credential itself. A BYO choice stays.
 *
 * @param state - The record before the withdrawal.
 * @returns The cleared copy.
 */
export function clearedRemoteState(state: RemoteState): RemoteState {
  return {
    ...withdrawnRemoteState(state),
    credentialRef: null,
    credentialId: null,
    fingerprint: null,
    hosts: [],
    edgeProofRef: null,
    edgeProofHeader: null,
  };
}

/** Why {@link updateRemoteState} refused a write. Nothing was written. */
export class RemoteStateWriteError extends Error {
  /**
   * Build the refusal.
   *
   * @param message - What was wrong, naming fields, never values.
   */
  constructor(message: string) {
    super(message);
    this.name = 'RemoteStateWriteError';
  }
}

/**
 * Write part of the `cloud.remote` record, validating the whole result.
 *
 * Hosts are lower-cased and de-duplicated, because hostnames compare without
 * regard to case and the managed listener serves each one once. A write that
 * would select `managed` without an active enrolment is refused, and so is a
 * credential reference without the credential id it belongs to.
 *
 * @param subsystem - What is writing, as a person would name it, for the log
 *   line ("managed remote setup", "withdrawing managed remote access").
 * @param patch - The fields to change; absent fields keep their value.
 * @returns The record as stored.
 * @throws {RemoteStateWriteError} When the result would be invalid; nothing is
 *   written.
 */
export function updateRemoteState(subsystem: string, patch: Partial<RemoteState>): RemoteState {
  const current = readRemoteState();
  const merged: RemoteState = { ...current, ...patch };
  if (patch.hosts !== undefined) {
    merged.hosts = [...new Set(patch.hosts.map((host) => host.trim().toLowerCase()))].filter(
      (host) => host.length > 0
    );
  }

  const parsed = RemoteAccessSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new RemoteStateWriteError(`cloud.remote was not changed: invalid ${fields.join(', ')}.`);
  }
  const next = parsed.data;
  if (next.mode === 'managed' && !isRemoteEnrolmentActive(next)) {
    throw new RemoteStateWriteError(
      'cloud.remote was not changed: managed mode needs an enrolment a person approved.'
    );
  }
  // The published grammar, not a copy: it also refuses a header HTTP, a proxy
  // or a session already uses (`REMOTE_EDGE_PROOF_RESERVED_HEADERS`,
  // `x-forwarded-*`), so honouring the proof can never mean stripping one.
  if (
    next.edgeProofHeader !== null &&
    !RemoteEdgeProofSchema.shape.header.safeParse(next.edgeProofHeader).success
  ) {
    throw new RemoteStateWriteError('cloud.remote was not changed: invalid edgeProofHeader.');
  }
  if ((next.credentialRef !== null || next.edgeProofRef !== null) && next.credentialId === null) {
    throw new RemoteStateWriteError(
      'cloud.remote was not changed: a stored credential needs its credential id.'
    );
  }

  const cloud = configManager.get('cloud');
  configManager.set('cloud', { ...cloud, remote: next });
  logConfigWrite(subsystem, 'cloud', cloud, configManager.get('cloud'));
  return structuredClone(next);
}
