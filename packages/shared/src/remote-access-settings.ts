/**
 * The `cloud.remote` config block: managed remote access (DOR-2086).
 * Re-exported from `config-schema.ts`, which is where callers import it.
 *
 * Schemas, constants and pure functions only, for the reason `config-schema.ts`
 * gives at its top.
 *
 * @module remote-access-settings
 */
import { z } from 'zod';
import { CredentialReferenceSchema } from './credential-reference.js';

/**
 * How this computer is reachable from other devices (DOR-2086):
 *
 * - `off` — not reachable from outside this computer.
 * - `byo` — the person's own ngrok account, set up under `tunnel.*`.
 * - `managed` — DorkOS Cloud hands this computer its address and credential,
 *   after a person approved that on this computer.
 *
 * Only one runs at a time. Choosing `managed` never touches `tunnel.*`, so
 * switching back to `byo` finds the person's own setup exactly as they left it.
 */
export const REMOTE_ACCESS_MODES = ['off', 'byo', 'managed'] as const;

/** One of {@link REMOTE_ACCESS_MODES}. */
export const RemoteAccessModeSchema = z.enum(REMOTE_ACCESS_MODES);

/** How this computer is reachable from other devices. See {@link REMOTE_ACCESS_MODES}. */
export type RemoteAccessMode = z.infer<typeof RemoteAccessModeSchema>;

/**
 * The managed remote access record (`cloud.remote`, DOR-2086).
 *
 * **No secret lives here.** The tunnel credential and the edge proof secret are
 * stored encrypted under `{dorkHome}` and named by `file:` references, which
 * the server resolves just before it forwards. A raw secret fails the
 * {@link CredentialReferenceSchema} pattern, so it cannot be saved here by
 * mistake. Nothing is copied from `tunnel.*`: the person's own ngrok token is
 * theirs, and managed access uses only what Cloud issued for it.
 *
 * Written by exactly one server module (`services/core/remote/remote-state.ts`);
 * every leaf is operator-only for agents, and the general config door refuses
 * the whole block.
 */
export const RemoteAccessSettingsSchema = z.object({
  /**
   * The person's selected mode. `off` until a person picks one; choosing
   * `managed` here does not open anything on its own — Cloud's `open` command
   * does, and only while the enrolment below is in place.
   */
  mode: RemoteAccessModeSchema.default('off'),
  /**
   * The Cloud enrolment a person approved for this computer, or `null` when
   * nobody has. Only a person's approval creates one; withdrawal clears it.
   */
  enrolmentId: z.string().min(1).nullable().default(null),
  /** Which version of the consent text the person agreed to, carried from the enrolment. */
  consentVersion: z.string().min(1).nullable().default(null),
  /**
   * The Cloud instance id of the link the enrolment was made under, or `null`.
   * Binds the consent to that link: a Cloud command arriving on any other link
   * is refused, and unlinking clears it with the enrolment.
   */
  instanceId: z.string().min(1).nullable().default(null),
  /** Reference to the stored tunnel credential (`file:remote-tunnel-<credentialId>`). */
  credentialRef: CredentialReferenceSchema.nullable().default(null),
  /** Cloud's id for the credential in use, or `null` when there is none. */
  credentialId: z.string().min(1).nullable().default(null),
  /** Cloud's digest of that credential: safe to log and compare, never the value. */
  fingerprint: z.string().min(1).nullable().default(null),
  /**
   * Every hostname this computer serves in managed mode, lower-cased. The
   * complete set from the last credential that carried one.
   */
  hosts: z.array(z.string().min(1)).default(() => []),
  /** Reference to the stored edge proof secret (`file:remote-edge-<credentialId>`). */
  edgeProofRef: CredentialReferenceSchema.nullable().default(null),
  /**
   * The lower-case request header the managed edge carries its proof in. A
   * header name, not a secret; mirrors the `RemoteEdgeProofSchema.header`
   * grammar in `@dork-labs/cloud-api`.
   */
  edgeProofHeader: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a lower-case header name')
    .nullable()
    .default(null),
});

/** The `cloud.remote` block. See {@link RemoteAccessSettingsSchema}. */
export type RemoteAccessSettings = z.infer<typeof RemoteAccessSettingsSchema>;

/**
 * The `cloud.remote` block a computer that never chose managed access holds.
 * One definition, so the section default, the parent factory and the
 * migration cannot disagree.
 */
export function defaultRemoteAccessSettings(): RemoteAccessSettings {
  return {
    mode: 'off',
    enrolmentId: null,
    consentVersion: null,
    instanceId: null,
    credentialRef: null,
    credentialId: null,
    fingerprint: null,
    hosts: [],
    edgeProofRef: null,
    edgeProofHeader: null,
  };
}
