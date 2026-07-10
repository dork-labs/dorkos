/**
 * Prompt-injection-safe formatting of the `<ui_action>` user-turn block that a
 * widget interaction triggers.
 *
 * Split out from the widget catalog schema (`./ui-widget`) because it is a
 * distinct concern: turning an interaction into the plain message TEXT fed to a
 * runtime's `sendMessage`, safe against untrusted (agent-authored / user-typed)
 * fields breaking out of the block. Re-exported from `./ui-widget` so the public
 * `@dorkos/shared/ui-widget` import surface is unchanged.
 *
 * @module shared/ui-action-message
 */
import type { UiActionRequest } from './schemas.js';

/**
 * Matches C0/C1 control characters (including newlines) — anything that could
 * reshape the line structure of a prompt-injected context block.
 */
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Neutralize the closing-tag sequence of a prompt context block inside untrusted
 * text, so the text can never terminate the block early. `</tag`, with any
 * whitespace around the slash and any casing, becomes `<\/tag` — visibly the
 * same to the agent, but no longer the literal terminator.
 *
 * @param text - Untrusted text embedded inside a `<tag>…</tag>` context block
 * @param tag - The block's tag name (e.g. `ui_action`)
 */
export function neutralizeContextClosingTag(text: string, tag: string): string {
  const closing = new RegExp(`<\\s*/\\s*${tag}`, 'gi');
  return text.replace(closing, `<\\/${tag}`);
}

/**
 * Sanitize an untrusted scalar for interpolation into a single line of a
 * prompt-injected context block: control characters (including newlines) are
 * flattened to spaces so the value cannot forge new lines or fake context tags,
 * and the block's closing-tag sequence is neutralized so the value cannot
 * terminate the block early.
 *
 * Untrusted means untrusted: widget action ids and titles come from agent
 * output and marketplace skill templates; form values are user-typed.
 *
 * @param value - Untrusted scalar destined for one line of the block
 * @param tag - The enclosing block's tag name (e.g. `ui_action`)
 */
export function sanitizeContextScalar(value: string, tag: string): string {
  return neutralizeContextClosingTag(value.replace(CONTROL_CHARS, ' ').trim(), tag);
}

/** The `<ui_action>` block's tag name, shared by the formatter and its callers. */
const UI_ACTION_TAG = 'ui_action';

/**
 * Render a widget `agent`-action interaction into the `<ui_action>` user-turn
 * block that triggers the agent's next turn (spec gen-ui-tier1 §3).
 *
 * Runtime-neutral by construction — the block is the plain message TEXT fed to
 * `sendMessage`, so every runtime receives it identically. Shared (not
 * server-only) so the HTTP path (server route) and the in-process
 * `DirectTransport` path (Obsidian) emit a byte-identical block. Includes the
 * action id, the widget title (when known), and the payload (form values already
 * merged in client-side) so the agent can respond to the specific control fired.
 *
 * Every interpolated field is untrusted (agent-authored widgets, marketplace
 * skill templates, user-typed form values) and is sanitized so it cannot break
 * out of the block: scalars are flattened via {@link sanitizeContextScalar}; the
 * serialized payload keeps its JSON formatting but has the closing-tag sequence
 * neutralized via {@link neutralizeContextClosingTag} (JSON.stringify already
 * escapes newlines inside string values).
 *
 * @param action - The ui-action request: actionId, optional payload, optional
 *   widget title/id
 */
export function formatUiActionMessage(action: UiActionRequest): string {
  const title = action.widgetTitle ? sanitizeContextScalar(action.widgetTitle, UI_ACTION_TAG) : '';
  const lines: string[] = [
    `<${UI_ACTION_TAG}>`,
    'The user interacted with a widget you rendered.',
    `Widget: ${title || '(untitled)'}`,
    `Action: ${sanitizeContextScalar(action.actionId, UI_ACTION_TAG)}`,
  ];
  if (action.widgetId) {
    lines.push(`Widget ID: ${sanitizeContextScalar(action.widgetId, UI_ACTION_TAG)}`);
  }
  const hasPayload = action.payload && Object.keys(action.payload).length > 0;
  lines.push(
    hasPayload
      ? `Payload:\n${neutralizeContextClosingTag(JSON.stringify(action.payload, null, 2), UI_ACTION_TAG)}`
      : 'Payload: (none)'
  );
  lines.push(
    'Respond to this interaction now. If the widget represents ongoing state (a game, a ' +
      'checklist), re-emit exactly ONE updated widget reflecting it — trust this payload over ' +
      'your memory of prior turns.'
  );
  lines.push(`</${UI_ACTION_TAG}>`);
  return lines.join('\n');
}
