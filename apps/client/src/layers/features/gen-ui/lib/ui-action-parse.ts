/**
 * Lenient parser for the `<ui_action>` block a widget interaction injects as the
 * next user turn. The block reaches the client verbatim (it is the real user
 * turn content, not a stripped context tag), so both the live optimistic message
 * and the reloaded transcript carry it — and both render as the same interaction
 * chip instead of raw XML.
 *
 * Parsing is deliberately tolerant: the formatter's own lines (`Widget:`,
 * `Action:`, optional `Widget ID:`, `Payload:`) are recognized in any order, and
 * unknown extra lines — including a trailing directive a sibling agent may append
 * inside the block — are ignored. Anything with an `Action:` produces a chip.
 *
 * @module features/gen-ui/lib/ui-action-parse
 */

/** A parsed `<ui_action>` block, ready to render as an interaction chip. */
export interface ParsedUiAction {
  /** The widget title, or `null` when untitled/absent. */
  title: string | null;
  /** The action id that fired (e.g. `move-1-1`). */
  actionId: string;
  /** The optional widget instance id. */
  widgetId: string | null;
  /** The parsed payload object, or `null` when absent/unparseable (not displayed). */
  payload: Record<string, unknown> | null;
}

/** Match the first `<ui_action>…</ui_action>` block, if any. */
const UI_ACTION_BLOCK = /<ui_action>([\s\S]*?)<\/ui_action>/;

/** Best-effort JSON parse — returns `null` rather than throwing on bad input. */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Detect and parse a `<ui_action>` block inside a user message's content.
 * Returns `null` when the content carries no recognizable interaction block.
 *
 * @param content - The raw user-message content (may contain other text).
 */
export function parseUiActionMessage(content: string): ParsedUiAction | null {
  const match = content.match(UI_ACTION_BLOCK);
  if (!match) return null;
  const lines = match[1].split('\n');

  let title: string | null = null;
  let actionId: string | null = null;
  let widgetId: string | null = null;
  let payload: Record<string, unknown> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const widget = line.match(/^\s*Widget:\s*(.*)$/);
    if (widget) {
      const value = widget[1].trim();
      title = value && value !== '(untitled)' ? value : null;
      continue;
    }
    const action = line.match(/^\s*Action:\s*(.*)$/);
    if (action) {
      actionId = action[1].trim();
      continue;
    }
    const wid = line.match(/^\s*Widget ID:\s*(.*)$/);
    if (wid) {
      widgetId = wid[1].trim() || null;
      continue;
    }
    const pay = line.match(/^\s*Payload:\s*(.*)$/);
    if (pay) {
      const inline = pay[1].trim();
      if (inline && inline !== '(none)') {
        payload = tryParseJson(inline);
      } else if (!inline) {
        // Multi-line JSON follows on the next lines. Accumulate line by line and
        // stop at the first complete JSON object, so a trailing directive line the
        // formatter appends after the payload (added in the interaction-protocol
        // fixes) is not swallowed into the parse.
        let acc = '';
        for (let j = i + 1; j < lines.length; j++) {
          acc += (acc ? '\n' : '') + lines[j];
          const candidate = tryParseJson(acc.trim());
          if (candidate) {
            payload = candidate;
            break;
          }
        }
      }
      break;
    }
  }

  if (!actionId) return null;
  return { title, actionId, widgetId, payload };
}
