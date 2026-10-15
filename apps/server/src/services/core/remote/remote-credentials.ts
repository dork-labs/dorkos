/**
 * Where the managed tunnel credential and its edge proof secret are kept
 * (DOR-2086).
 *
 * Both are one-time values Cloud returns exactly once, with the credential it
 * issues. They are stored encrypted under `{dorkHome}` by the same
 * `EncryptedFileCredentialStore` the runtime credentials use, each under
 * a name derived from Cloud's credential id:
 *
 * - `remote-tunnel-<credentialId>` — the tunnel credential's value.
 * - `remote-edge-<credentialId>` — the edge proof secret.
 *
 * Config holds only the `file:` references to them (`cloud.remote`, written by
 * `remote-state.ts`). A rotation stores the replacement under its own id before
 * anything switches to it, so the credential in use is never overwritten in
 * place.
 *
 * ## Resolved just before use, and refused when it does not line up
 *
 * {@link RemoteCredentials.resolve} is called by whoever is about to forward,
 * immediately before it does. It accepts a reference only when it is exactly
 * the name this module would have written for the record's credential id, so a
 * hand-edited reference cannot aim the managed tunnel at another stored secret
 * (a runtime's API key, say). A missing or mismatched value is a typed
 * `blocked` result the report can show — never an empty string, and never an
 * exception that might carry the value.
 *
 * ## Who may write
 *
 * `remoteCredentials.put(` and `remoteCredentials.delete(` are protected
 * effects in `capabilities/__tests__/gate-bypass-scan.test.ts`, and so is
 * constructing another {@link RemoteCredentials}. Nothing here logs a value.
 *
 * @module services/core/remote/remote-credentials
 */
import { credentialStore, type CredentialStore } from '../credential-provider.js';
import type { RemoteState } from './remote-state.js';

/** The store-name prefix of a managed tunnel credential. */
const REMOTE_TUNNEL_SECRET_PREFIX = 'remote-tunnel-';

/** The store-name prefix of a managed edge proof secret. */
const REMOTE_EDGE_SECRET_PREFIX = 'remote-edge-';

/**
 * Cloud credential ids are opaque, but they become part of a store name, so
 * only a conservative character set is accepted.
 */
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The references {@link RemoteCredentials.put} returns, to be saved in `cloud.remote`. */
export interface RemoteCredentialRefs {
  /** `file:remote-tunnel-<credentialId>`. */
  credentialRef: string;
  /** `file:remote-edge-<credentialId>`. */
  edgeProofRef: string;
}

/** Why a stored managed credential cannot be used. */
export type RemoteCredentialBlockedReason =
  /** The record names no credential: managed setup has not finished, or was withdrawn. */
  | 'no_credential'
  /** A reference does not match the record's credential id, or the id is malformed. */
  | 'mismatched_reference'
  /** The reference is right but the stored value is gone. Setup needs repairing. */
  | 'missing_secret'
  /** The encrypted store could not be read. */
  | 'store_unavailable';

/** The secrets for one managed credential, or why they cannot be had. */
export type RemoteCredentialResolution =
  | { ok: true; credentialId: string; value: string; edgeProofSecret: string }
  | { ok: false; state: 'blocked'; reason: RemoteCredentialBlockedReason };

/** Raised when a store write failed. Carries no value and no underlying message. */
export class RemoteCredentialStoreError extends Error {
  constructor() {
    super('The remote access credential could not be stored on this computer.');
    this.name = 'RemoteCredentialStoreError';
  }
}

/**
 * The store names for a credential id.
 *
 * @param credentialId - Cloud's credential id.
 * @returns The two names, or `null` when the id is not safe to use as one.
 */
export function remoteSecretNames(credentialId: string): { tunnel: string; edge: string } | null {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) return null;
  return {
    tunnel: `${REMOTE_TUNNEL_SECRET_PREFIX}${credentialId}`,
    edge: `${REMOTE_EDGE_SECRET_PREFIX}${credentialId}`,
  };
}

/** Put, read and forget the managed credential's two secrets. See the module doc. */
export class RemoteCredentials {
  /**
   * Build a handle over one encrypted store.
   *
   * @param store - Resolves the encrypted store. A function, so the module
   *   singleton can be built before `initCredentialProvider` runs at boot.
   */
  constructor(private readonly store: () => CredentialStore) {}

  /**
   * Store a freshly issued credential's value and edge proof secret.
   *
   * Both or neither: if the second write fails, the first is removed again.
   *
   * @param input.credentialId - Cloud's id for the issued credential.
   * @param input.value - The tunnel credential value, returned once by Cloud.
   * @param input.edgeProofSecret - The edge proof secret, returned once with it.
   * @returns The references to save in `cloud.remote`.
   * @throws {RemoteCredentialStoreError} When the id is unusable or a write failed.
   */
  async put(input: {
    credentialId: string;
    value: string;
    edgeProofSecret: string;
  }): Promise<RemoteCredentialRefs> {
    const names = remoteSecretNames(input.credentialId);
    if (names === null || input.value === '' || input.edgeProofSecret === '') {
      throw new RemoteCredentialStoreError();
    }
    const store = this.store();
    let credentialRef: string;
    try {
      credentialRef = await store.put(names.tunnel, input.value);
    } catch {
      throw new RemoteCredentialStoreError();
    }
    try {
      const edgeProofRef = await store.put(names.edge, input.edgeProofSecret);
      return { credentialRef, edgeProofRef };
    } catch {
      await store.delete(names.tunnel).catch(() => undefined);
      throw new RemoteCredentialStoreError();
    }
  }

  /**
   * Forget both secrets of a credential. Safe to call when they are absent.
   *
   * @param credentialId - Cloud's id for the credential to forget.
   */
  async delete(credentialId: string): Promise<void> {
    const names = remoteSecretNames(credentialId);
    if (names === null) return;
    const store = this.store();
    // Both are attempted even when the first fails, so a half-forgotten
    // credential cannot linger behind an error.
    const results = await Promise.allSettled([
      store.delete(names.tunnel),
      store.delete(names.edge),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new RemoteCredentialStoreError();
    }
  }

  /**
   * Read the secrets for the record's credential, just before forwarding.
   *
   * @param state - The `cloud.remote` record to resolve.
   * @returns The secrets, or `blocked` with the reason.
   */
  async resolve(
    state: Pick<RemoteState, 'credentialId' | 'credentialRef' | 'edgeProofRef'>
  ): Promise<RemoteCredentialResolution> {
    const { credentialId, credentialRef, edgeProofRef } = state;
    if (credentialId === null || credentialRef === null || edgeProofRef === null) {
      return { ok: false, state: 'blocked', reason: 'no_credential' };
    }
    const names = remoteSecretNames(credentialId);
    if (
      names === null ||
      credentialRef !== `file:${names.tunnel}` ||
      edgeProofRef !== `file:${names.edge}`
    ) {
      return { ok: false, state: 'blocked', reason: 'mismatched_reference' };
    }
    const store = this.store();
    let value: string | null;
    let edgeProofSecret: string | null;
    try {
      [value, edgeProofSecret] = await Promise.all([
        store.get(names.tunnel),
        store.get(names.edge),
      ]);
    } catch {
      return { ok: false, state: 'blocked', reason: 'store_unavailable' };
    }
    if (!value || !edgeProofSecret) {
      return { ok: false, state: 'blocked', reason: 'missing_secret' };
    }
    return { ok: true, credentialId, value, edgeProofSecret };
  }
}

/**
 * The module singleton, over the boot-initialized encrypted store.
 *
 * Built here and nowhere else in production code: constructing another
 * {@link RemoteCredentials} is watched by the gate-bypass scan.
 */
export const remoteCredentials = new RemoteCredentials(() => credentialStore);
