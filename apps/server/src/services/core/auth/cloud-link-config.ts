/** Lazy persistent config adapter for the cloud-link lifecycle.
 * @module services/core/auth/cloud-link-config
 */
import { configManager } from '../config-manager.js';
import { logConfigWrite } from '../operator/config-write.js';
import { withRemoteForNewKey, withdrawnRemoteState } from '../remote/remote-state.js';

/** Config read/write seam over the `cloud.*` section, injectable for tests. */
export interface CloudConfigPort {
  getToken(): string | null;
  getAccountLabel(): string | null;
  /** The kept relink proof of the last dropped instance key, or `null` (also when absent). */
  getPreviousLinkProof(): string | null;
  /** Store a newly issued key. A new link consumes any kept relink proof (sets it `null`). */
  save(link: { instanceToken: string; instanceName: string }): void;
  setAccountLabel(label: string | null): void;
  /**
   * Drop the instance key, name and account label, keeping `previousLinkProof`
   * so the next link can ask the cloud to continue this one.
   */
  clear(keep: { previousLinkProof: string | null }): void;
}

/** Default config port backed by the `configManager` singleton (resolved lazily). */
export function defaultConfigPort(): CloudConfigPort {
  return {
    getToken: () => configManager.get('cloud')?.instanceToken ?? null,
    getAccountLabel: () => configManager.get('cloud')?.linkedAccountLabel ?? null,
    // Configs written before the field existed carry no leaf at all; absence is `null`.
    getPreviousLinkProof: () => configManager.get('cloud')?.previousLinkProof ?? null,
    save: ({ instanceToken, instanceName }) => {
      const current = configManager.get('cloud');
      // `cloud.instanceToken` is registered in SENSITIVE_CONFIG_KEYS; the write
      // path mirrors how `tunnel.authtoken` is stored (whole-section set). The
      // token value is never logged — `logConfigWrite` names paths only. The
      // new link has consumed any kept relink proof, so it goes too. A key that
      // replaces another withdraws managed remote access locally, as an unlink
      // would (DOR-2086): a consent given under the old link is not this one's.
      configManager.set('cloud', {
        ...withRemoteForNewKey(current, instanceToken),
        instanceToken,
        instanceName,
        previousLinkProof: null,
      });
      logConfigWrite('the account link', 'cloud', current, configManager.get('cloud'));
    },
    setAccountLabel: (label) => {
      // The heartbeat reports the owning account's label; persist it so
      // `GET /api/cloud/status` and `dorkos cloud status` can show which account
      // this instance is linked to. No-op write when unchanged.
      const current = configManager.get('cloud');
      if ((current?.linkedAccountLabel ?? null) === label) return;
      configManager.set('cloud', { ...current, linkedAccountLabel: label });
      logConfigWrite('the account link', 'cloud', current, configManager.get('cloud'));
    },
    clear: ({ previousLinkProof }) => {
      const current = configManager.get('cloud');
      configManager.set('cloud', {
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
        previousLinkProof,
        // The person's credits choices outlive the link: a session set to
        // credits is refused while unlinked, never moved, and a relink finds
        // them as they were (ADR 261001-000811).
        credits: current.credits,
        // Unlinking withdraws managed remote access locally, in this same
        // write (DOR-2086): a managed mode goes off, and the enrolment and the
        // link it was bound to are cleared, so neither a different account's
        // link nor a relink of this one can act on a consent given under this
        // link. A BYO choice stays: the person's own ngrok needs no link. The
        // credential id and its references are kept for the best-effort Cloud
        // revoke and stored-secret cleanup that follow; with no enrolment
        // nothing can open with them. See `withdrawnRemoteState`.
        remote: withdrawnRemoteState(current.remote),
      });
      logConfigWrite('unlinking this instance', 'cloud', current, configManager.get('cloud'));
    },
  };
}
