/**
 * Client-side validation of a widget document against the shared wire schema.
 *
 * The server never structurally validates agent-authored widget JSON (ADR
 * 260708-111500) — the canvas `widget` content's `definition` is a bare
 * `z.custom<WidgetDocument>()` on the wire — so the client render boundary is
 * the sole validation point for BOTH delivery paths: the `dorkos-ui` fence
 * (string payload via {@link parseWidget}) and the canvas (already-parsed value
 * via {@link validateWidgetDocument}). A failure on either path degrades to the
 * D5 error card — neither the chat nor the canvas panel ever crashes.
 *
 * @module features/gen-ui/model/parse-widget
 */
import { WidgetDocumentSchema, type WidgetDocument } from '@dorkos/shared/ui-widget';

/** Result of validating a widget payload: either a valid document or an error. */
export type ParseWidgetResult =
  | { ok: true; document: WidgetDocument }
  | { ok: false; error: string; raw: string };

/**
 * Validate an already-parsed value (e.g. a canvas `widget` content's
 * `definition`) as a {@link WidgetDocument}. Never throws.
 *
 * @param value - The candidate widget document value
 * @param raw - Optional raw text for the error card; defaults to the value serialized
 */
export function validateWidgetDocument(value: unknown, raw?: string): ParseWidgetResult {
  const result = WidgetDocumentSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const message = first ? `${path ? `${path}: ` : ''}${first.message}` : 'Invalid widget';
    return { ok: false, error: message, raw: raw ?? safeStringify(value) };
  }
  return { ok: true, document: result.data };
}

/**
 * Parse a raw `dorkos-ui` fence body into a validated {@link WidgetDocument}.
 *
 * Never throws — malformed JSON and schema violations both resolve to an
 * `{ ok: false }` result carrying a short error and the raw text for the
 * collapsible error card.
 *
 * @param raw - The fence body (expected to be a single JSON widget document)
 */
export function parseWidget(raw: string): ParseWidgetResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON', raw };
  }
  return validateWidgetDocument(json, raw);
}

/** Serialize a value for the error card, tolerating cycles and BigInt. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
