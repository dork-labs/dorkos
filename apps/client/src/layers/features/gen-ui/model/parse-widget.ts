/**
 * Client-side validation of a widget document against the shared wire schema.
 *
 * The server never structurally validates agent-authored widget JSON (ADR
 * 260708-111500), so the client is the sole validation boundary. A parse failure
 * degrades to the D5 error card — the chat never crashes.
 *
 * @module features/gen-ui/model/parse-widget
 */
import { WidgetDocumentSchema, type WidgetDocument } from '@dorkos/shared/ui-widget';

/** Result of parsing a `dorkos-ui` payload: either a valid document or an error. */
export type ParseWidgetResult =
  | { ok: true; document: WidgetDocument }
  | { ok: false; error: string; raw: string };

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

  const result = WidgetDocumentSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const message = first ? `${path ? `${path}: ` : ''}${first.message}` : 'Invalid widget';
    return { ok: false, error: message, raw };
  }

  return { ok: true, document: result.data };
}
