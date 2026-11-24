/**
 * Reading a refusal from the `/api/local-browser` routes.
 *
 * Every refusal is a problem document whose `code` is the one to branch on:
 * `signing_in`, `history_refused`, `precondition_failed` (the page or the
 * profiles folder changed), the routes' own `operator_only` and `person_only`,
 * and `conflict` for the rest, whose sentence is the whole message.
 *
 * @module entities/local-browser/lib/browser-refusal
 */

/**
 * The code a failed local-browser call names.
 *
 * @param cause - The error the transport threw.
 * @returns The code, or `undefined` when the answer named none.
 */
export function browserRefusalCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
