/**
 * Keeps a held community's credentials out of everything a run writes.
 *
 * @module community-two-desktop/redact
 */

/** What a redacted secret is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Build a function that replaces every given secret in a piece of text,
 * whether it appears as written, URL-encoded, or escaped inside JSON.
 *
 * @param secrets - The values that must never be written out.
 */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const forms = [
    ...new Set(
      secrets
        .filter((secret) => secret.length > 0)
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ])
    ),
  ].sort((x, y) => y.length - x.length); // longest first, so a secret inside another is never left half-hidden
  return (text) => forms.reduce((out, form) => out.split(form).join(REDACTED), text);
}
