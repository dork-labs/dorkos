/**
 * The credential-reference grammar: how config names a secret without holding
 * it. Re-exported from `config-schema.ts`, which is where callers import it.
 *
 * Schemas, constants and pure functions only, for the reason `config-schema.ts`
 * gives at its top.
 *
 * @module credential-reference
 */
import { z } from 'zod';

/**
 * Credential-reference schemes recognized by the `CredentialProvider` port
 * (ADR-0315). A stored credential is always one of these references, never a
 * raw secret.
 */
export const CREDENTIAL_SCHEMES = ['keychain', 'env', 'file'] as const;

/** One of the recognized {@link CREDENTIAL_SCHEMES}. */
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number];

/**
 * A credential value stored in config is a REFERENCE, never plaintext:
 * `keychain:<id>` (OS keychain), `env:<VAR>` (process env), or `file:<name>`
 * (encrypted dork-home secret store). The value after the scheme must be
 * non-empty. This pattern is the schema-level guard that keeps raw secrets out
 * of `config.json` — a plaintext key (e.g. `sk-ant-...`) fails validation
 * (ADR-0315, decision: never persist plaintext).
 */
export const CREDENTIAL_REF_PATTERN = /^(?:keychain|env|file):.+/;

/**
 * Zod schema for a single credential reference value. Rejects anything that is
 * not a well-formed `keychain:`/`env:`/`file:` reference — the structural
 * guarantee that a raw secret can never be persisted as a provider value.
 */
export const CredentialReferenceSchema = z
  .string()
  .regex(CREDENTIAL_REF_PATTERN, 'must be a keychain:/env:/file: reference, never a raw secret');

/**
 * Split a credential reference into its `scheme` and `value`, or return `null`
 * when the string is not a well-formed reference (no colon, an unrecognized
 * scheme, or an empty value). The lone parser for the reference grammar — the
 * `CredentialProvider` port and the schema guard share this single definition.
 *
 * @param ref - The stored reference string (e.g. `env:OPENROUTER_API_KEY`).
 */
export function parseCredentialReference(
  ref: string
): { scheme: CredentialScheme; value: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  const scheme = ref.slice(0, idx);
  const value = ref.slice(idx + 1);
  if (value.length === 0) return null;
  if (!(CREDENTIAL_SCHEMES as readonly string[]).includes(scheme)) return null;
  return { scheme: scheme as CredentialScheme, value };
}
