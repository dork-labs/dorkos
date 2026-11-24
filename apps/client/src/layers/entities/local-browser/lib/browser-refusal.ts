/**
 * Reading a refusal from the `/api/local-browser` routes.
 *
 * The browser's own refusals (`stale_page`, `signing_in`, `history_refused`…)
 * come back as a `409 conflict` problem with the refusal in its `reason`
 * member; the routes' own refusals (`operator_only`, `person_only`,
 * `outside_turn`…) are the problem's `code`.
 *
 * @module entities/local-browser/lib/browser-refusal
 */

/**
 * The refusal a failed local-browser call names: the browser's `reason` when
 * the answer carries one, else the problem's `code`.
 *
 * @param cause - The error the transport threw.
 * @returns The refusal, or `undefined` when the answer named none.
 */
export function browserRefusalCode(cause: unknown): string | undefined {
  const error = cause as { code?: unknown; body?: unknown } | null | undefined;
  const reason = (error?.body as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason === 'string') return reason;
  return typeof error?.code === 'string' ? error.code : undefined;
}
