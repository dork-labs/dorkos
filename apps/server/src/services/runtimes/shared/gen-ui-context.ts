/**
 * Runtime-neutral teaching block for Tier-1 generative UI (`<gen_ui>`).
 *
 * Widgets are delivered as fenced JSON in ordinary assistant text (ADR
 * 260708-111500), so — unlike `control_ui` — there is no tool to register: every
 * runtime just emits text. This one compact block teaches the fence syntax and
 * catalog, and is injected into the cacheable system-prompt prefix by the Claude
 * Code adapter and prepended to the codex/opencode prompt inputs. Defining it
 * once here (zod-free, SDK-free) keeps the three runtimes byte-for-byte in sync
 * and honors the DRY rule.
 *
 * @module services/runtimes/shared/gen-ui-context
 */

/**
 * The `<gen_ui>` static context block. Compact by design — it rides the
 * cacheable prefix on every turn.
 */
export const GEN_UI_CONTEXT = `<gen_ui>
DorkOS generative UI lets you render native, interactive widgets inline in chat.
Emit a fenced code block with language "dorkos-ui" whose body is a single JSON
widget document. It renders in place of the code block; invalid JSON shows an
error card, never breaking the chat.

Document: { "version": 1, "title"?: string, "root": <node> }

A <node> is { "type": <type>, ...props }. Catalog:
  layout: stack { direction: "vertical"|"horizontal", gap?: "sm"|"md"|"lg", children: node[] },
          card { title?, description?, children: node[], footer?: node[] }, divider
  text:   heading { text, level?: 1|2|3 }, text { text (inline markdown) },
          badge { text, tone?: "default"|"success"|"warning"|"error"|"info" }
  data:   stat { label, value, delta?: { value, direction: "up"|"down"|"flat" }, hint?, trend?: number[] },
          keyValue { items: [{ key, value }] }, progress { value: 0-100, label? },
          table { columns: [{ key, label, align? }], rows: [{ <key>: string|number|boolean|null }] },
          list { items: [{ title, subtitle?, icon?, image?, meta?, badge?, actions? }] },
          chart { kind: "bar"|"line"|"area"|"pie", data: [{ label, value }], height? } (values >= 0),
          timeline { items: [{ title, time?, subtitle?, icon?, status?: "done"|"active"|"upcoming" }] },
          checklist { items: [{ label, checked?, note? }], action?, submitLabel? } (checked labels post back via action),
          compare { options: [{ name, recommended? }], rows: [{ label, values: (string|number|boolean|null)[] }] },
          rating { value: 0-5, count?, label? }
  media:  image { src (https/data only), alt, caption? }
  action: button { label, variant?, action }, form { children: node[], submit: { label, action } },
          input { name, label?, placeholder?, kind? }, select { name, label?, options: [{ label, value }] }

Actions are one of: { kind: "ui", command: <control_ui command> } (dispatched locally),
{ kind: "url", href: "https://…" }, or { kind: "agent", id, label?, payload? } (sent back to you).

When a user activates an "agent" action, you get a <ui_action> user turn with
the widget title, action id, and payload (form values merged in). Give actions
stable ids.

Example — a stat card:
\`\`\`dorkos-ui
{ "version": 1, "root": { "type": "card", "title": "Weather", "children": [
  { "type": "stat", "label": "San Francisco", "value": "64°F", "delta": { "value": "+2°", "direction": "up" } } ] } }
\`\`\`

Use widgets for structured data the user will scan (metrics, tables, lists, charts).
Do NOT wrap plain prose in a widget.

Skills may ship widgets under ui/*.widget.json — read one, fill its {{placeholders}}, emit it.
</gen_ui>`;
