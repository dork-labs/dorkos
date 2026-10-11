/**
 * Who may write each `cloud.remote` leaf, and which refusal stake it belongs to
 * (DOR-2086). Spread into `CONFIG_WRITE_POLICY` and `OPERATOR_ONLY_STAKES` in
 * `operator/config-write-policy.ts`, whose drift guards cover these leaves like
 * any other.
 *
 * Every leaf is a person's alone: whether this computer is reachable from the
 * internet through DorkOS Cloud, the consent a person gave for it, and the
 * credential it forwards with. The general config door refuses the whole block
 * anyway (`USE_REMOTE_ACCESS_API`), because only `remote-state.ts` writes it.
 *
 * @module services/core/remote/remote-config-policy
 */

/** The leaves that decide who can reach this computer, and through what. */
export const CLOUD_REMOTE_REACH_PATHS = [
  'cloud.remote.mode',
  'cloud.remote.enrolmentId',
  'cloud.remote.consentVersion',
  'cloud.remote.instanceId',
  'cloud.remote.hosts',
  'cloud.remote.edgeProofHeader',
] as const;

/** The leaves that name the stored credential: references and ids, never a secret. */
export const CLOUD_REMOTE_CREDENTIAL_PATHS = [
  'cloud.remote.credentialRef',
  'cloud.remote.credentialId',
  'cloud.remote.fingerprint',
  'cloud.remote.edgeProofRef',
] as const;

type CloudRemotePath =
  (typeof CLOUD_REMOTE_REACH_PATHS)[number] | (typeof CLOUD_REMOTE_CREDENTIAL_PATHS)[number];

/** Every `cloud.remote` leaf, operator-only. */
export const CLOUD_REMOTE_WRITE_POLICY = Object.fromEntries(
  [...CLOUD_REMOTE_REACH_PATHS, ...CLOUD_REMOTE_CREDENTIAL_PATHS].map((path) => [
    path,
    'operator-only' as const,
  ])
) as Record<CloudRemotePath, 'operator-only'>;

/**
 * What a computer that never chose managed access holds under `cloud.remote`,
 * written out rather than read from the schema so the safe-defaults drift guard
 * in `safe-defaults/default-verdicts.ts` still catches a default that moves.
 * Every leaf is the protective option: not reachable through DorkOS, with no
 * consent, link, credential or hostname.
 */
export const CLOUD_REMOTE_SAFE_DEFAULTS = {
  'cloud.remote.mode': 'off',
  'cloud.remote.enrolmentId': null,
  'cloud.remote.consentVersion': null,
  'cloud.remote.instanceId': null,
  'cloud.remote.credentialRef': null,
  'cloud.remote.credentialId': null,
  'cloud.remote.fingerprint': null,
  'cloud.remote.hosts': [],
  'cloud.remote.edgeProofRef': null,
  'cloud.remote.edgeProofHeader': null,
} as const satisfies Record<CloudRemotePath, unknown>;
