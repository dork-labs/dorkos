# Generative UI Tier 1 — Specification

**Date:** 2026-07-08 · **Depends on decisions:** `01-ideation.md` (D1–D5)
**Implementation split:** PR D (schema + catalog + renderer + prompt block), PR E (ui-action channel).

## 1. Wire schema — `packages/shared/src/ui-widget.ts` (new, exported as `@dorkos/shared/ui-widget`)

```ts
WidgetDocumentSchema = {
  version: z.literal(1),
  title?: string,            // used as canvas tab title / a11y label
  root: WidgetNodeSchema,
}
```

`WidgetNodeSchema`: `z.discriminatedUnion('type', …)`, recursive via `z.lazy` for `children`. v1 catalog:

| type       | props (all validated, no passthrough)                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `stack`    | `direction: 'vertical'\|'horizontal'`, `gap?: 'sm'\|'md'\|'lg'`, `children: Node[]`                       |
| `card`     | `title?`, `description?`, `children: Node[]`, `footer?: Node[]`                                           |
| `divider`  | —                                                                                                         |
| `heading`  | `text`, `level?: 1\|2\|3`                                                                                 |
| `text`     | `text` (inline markdown allowed; rendered via existing markdown pipeline, no raw HTML)                    |
| `badge`    | `text`, `tone?: 'default'\|'success'\|'warning'\|'error'\|'info'`                                         |
| `stat`     | `label`, `value`, `delta?: { value, direction: 'up'\|'down'\|'flat' }`, `hint?`                           |
| `keyValue` | `items: { key, value }[]`                                                                                 |
| `image`    | `src` (https/data URI only in widgets), `alt`, `caption?`                                                 |
| `progress` | `value: 0-100`, `label?`                                                                                  |
| `table`    | `columns: { key, label, align? }[]`, `rows: Record<key, string\|number\|boolean\|null>[]`                 |
| `list`     | `items: { title, subtitle?, icon?: LucideName, badge?: {text, tone} , actions?: Action[] }[]`             |
| `chart`    | `kind: 'bar'\|'line'\|'area'\|'pie'`, `data: {label, value}[]` or `{series: …}` (keep minimal), `height?` |
| `button`   | `label`, `variant?: 'default'\|'secondary'\|'destructive'\|'outline'`, `action: Action`                   |
| `input`    | `name`, `label?`, `placeholder?`, `kind?: 'text'\|'number'` (only meaningful inside `form`)               |
| `select`   | `name`, `label?`, `options: {label, value}[]`                                                             |
| `form`     | `children: Node[]` (inputs/selects/text), `submit: { label, action: Action & {kind:'agent'} }`            |

`ActionSchema` (discriminated on `kind`):

- `{ kind: 'agent', id: string, label?: string, payload?: Record<string, unknown> }` — form values merged into payload at submit
- `{ kind: 'ui', command: UiCommand }` — reuses `UiCommandSchema`
- `{ kind: 'url', href: string }` — https only

Unknown `type` at parse time: the schema parse fails, but the client renderer must attempt per-node salvage only at the top level — i.e. v1 behavior is document-level validation; on failure render the error card (D5). Forward-compat comment required on the union.

## 2. Chat rendering (PR D)

- **Fence detection:** assistant markdown containing a ` ```dorkos-ui ` code fence renders a `WidgetBlock` instead of a code block. Integration point: streamdown supports custom `components`/code renderers — wire in `StreamingText.tsx` and `markdown-content.tsx` (`apps/client/src/layers/features/chat/ui/message/`, `layers/shared/ui/`). While the fence is still streaming (unclosed), render a skeleton (D3).
- **Renderer:** `apps/client/src/layers/features/gen-ui/` (new FSD feature): `ui/WidgetRenderer.tsx` (recursive switch), `ui/nodes/*` per catalog node using shadcn primitives + theme tokens, `model/parse-widget.ts` (safeParse + error shape). Charts use shadcn chart components (recharts) — add the dependency only if not already present.
- **Error card (D5):** parse failure → compact error card ("This widget couldn't be rendered") + collapsed raw JSON; must have a test.
- **Canvas:** add `{ type: 'widget', definition: WidgetDocument, title? }` to `UiCanvasContentSchema`, a `CanvasWidgetContent` renderer delegating to `WidgetRenderer`, and extend `UiStateSchema.canvas.contentType`. NOTE: coordinate with PR A (panels/desc edits) and PR C (image/pdf types) which touch the same enums — rebase onto whichever lands first.
- **Prompt teaching:** static `<gen_ui>` block alongside `<ui_tools>` in `context-builder.ts` (Claude) and the codex/opencode `turn-input.ts` equivalents: fence syntax, catalog summary with 2 short examples (a stat card; a table), guidance (use for structured data the user will scan; don't wrap plain prose in widgets). Keep it compact — it rides the cacheable prefix.
- **a11y/design bar:** keyboard-reachable actions, `focus-visible`, theme tokens only, loading/empty/error states (REVIEW.md enforces).

## 3. Interactivity channel (PR E)

- **Endpoint:** `POST /api/sessions/:id/ui-action` (routes/sessions.ts, thin, Zod-validated: `{ widgetId?, actionId, payload }`). Behavior modeled on `/submit-answers`: if a turn is idle, trigger a new turn whose user message is a structured `<ui_action>` block (rendered by `renderContextEntry`-style formatting, runtime-neutral via the additionalContext bag OR as message text — implementer picks the mechanism `submit-answers` already uses); if the session is busy, 409 or queue consistent with existing message queueing semantics.
- **Client:** `WidgetRenderer` receives an `onAction` dep; `agent` actions POST via Transport (new Transport method — remember `DirectTransport` for Obsidian must implement it too); `ui` actions call `executeUiCommand`; `url` actions follow LinkSafetyModal conventions.
- **Agent awareness:** the injected `<ui_action>` block includes actionId, payload, and widget title so the agent knows what was clicked. Update the `<gen_ui>` teaching block to describe what the agent receives.
- **PR D placeholder:** until E lands, `agent` actions render disabled with a tooltip ("interactions coming soon") behind a single feature-flag constant so E's enablement is a one-line flip plus deletion.

## 4. Acceptance criteria

1. Agent emitting a valid `dorkos-ui` fence sees it render as native UI inline in chat (verified in browser on all of: stat card, table, chart, list with badges).
2. Invalid JSON / unknown node type renders the error card; chat never crashes (unit + browser test).
3. `control_ui open_canvas` with `type:'widget'` renders the same widget in the canvas.
4. Prompt block teaches the syntax; a fresh session with no other prompting produces a renderable widget when asked to "show the weather nicely" (manual/browser check).
5. (PR E) ✅ Clicking an `agent` action lands a `<ui_action>` message in the agent's next turn; `ui` actions dispatch locally; form submit merges values into payload. — Shipped: `POST /api/sessions/:id/ui-action` (trigger-only, mirrors `/messages`; 409 SESSION_LOCKED when busy) + `Transport.sendUiAction` (HTTP + Direct) with optimistic buttons; covered by `sessions-ui-action.test.ts` and the client action-dispatch/form-merge tests.
6. All touched packages pass targeted typecheck/lint/tests; changelog fragments included; TSDoc on all exports.

## 5. Test plan

- `packages/shared`: schema round-trip + rejection tests (unknown type, wrong props, https enforcement).
- `apps/client`: WidgetRenderer node tests (RTL), fence-detection tests in the message pipeline, error-card test, canvas widget content test — mock Transport per `.claude/rules/testing.md`.
- `apps/server` (PR E): ui-action route tests with `FakeAgentRuntime` (idle → turn trigger with block; busy → queue/409 semantics; validation errors).
- Browser (both PRs): dev server + Playwright — acceptance items 1–4.
