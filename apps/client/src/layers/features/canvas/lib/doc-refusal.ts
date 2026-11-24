/**
 * Reading a refusal from the canvas document routes (`/api/canvas/docs`).
 *
 * The routes answer a problem document whose `code` follows the HTTP status
 * and whose `reason` member is the document channel's own refusal, in
 * `lower_snake` (`route_changed`, `work_already_reviewed`…). A refusal the
 * app's login gate gave first carries no `reason`, only its `code`.
 *
 * @module features/canvas/lib/doc-refusal
 */

/**
 * The refusal a failed document request names: its `reason` when the answer
 * carries one, else its `code`.
 *
 * @param error - The error the transport threw.
 * @returns The refusal, or `undefined` when the answer named none.
 */
export function docRefusalReason(error: unknown): string | undefined {
  const thrown = error as { code?: unknown; body?: unknown } | null | undefined;
  const reason = (thrown?.body as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason === 'string') return reason;
  return typeof thrown?.code === 'string' ? thrown.code : undefined;
}
