# How a click in the companion reaches the agent

Researched 2026-10-17 against DorkOS v0.119.0.

## Today: the companion server calls DorkOS

The page can't reach DorkOS directly, but the companion's Node server can. When the person
presses **Send** (or submits a pin note) on a screen that opts in with
`<meta name="vc-wake" content="on">`, the server calls:

```
POST http://localhost:4242/api/sessions/<session>/ui-action
{ "actionId": "visual-companion.send", "widgetTitle": "Visual companion · <screen>",
  "payload": { "summary": [...], "screens": [{ selection, pins, new_pins, ... }], "events_file": "..." } }
```

DorkOS turns that into a `<ui_action>` turn in the target chat, the same thing a dorkos-ui
`kind:"agent"` button produces. The target is the chat that ran `vc show`: its
`DORKOS_SESSION_ID` or `CLAUDE_CODE_SESSION_ID`, or `--session`.

It works because the call comes from Node with no `Origin` header (so CORS doesn't apply), the
host guard accepts `localhost`, and **with login off, a local request needs no credential**.

**With DorkOS login on, this path is refused** (401). The companion carries no credential and
doesn't try to get one. It logs the refusal to `state/route.log` (`vc route status`), and every
event stays in `state/events`, so the agent reads them with `vc events` instead.

While the chat is mid-turn, DorkOS answers `409 SESSION_LOCKED` (`ui-action` refuses when busy).
The companion keeps the batch and retries with backoff (3s to 30s, for up to 30 minutes), so it
lands as a turn once the chat is free. `tests/03-events.test.cjs` covers 409, retry, then 202
against a stub DorkOS and checks the exact body.

### Rules the server keeps

- **Intent only.** Clicks, slider drags, the theme toggle and history stay in `state/events`.
  Only `send` and `pin` events are forwarded, and only from screens whose file on disk has
  `vc-wake` on. The server checks the file and never trusts the page: a forged `send` from a
  quiet screen is recorded and goes nowhere (tested).
- **Batched.** 800ms batches, one call carrying the screen's full selection and every pin on it,
  capped under DorkOS's 8,192-character limit.
- **Bounded.** At most 20 wakes an hour, each attempt logged to `state/route.log`.
- **Alternative mode.** `vc route on --via message` posts to `/api/sessions/:id/messages`
  instead, with `X-DorkOS-Agent: $DORKOS_AGENT_TOKEN` when that is set. DorkOS queues it rather
  than refusing it. The token stays in the server's environment and is never written to disk.
- **Off switch.** `vc route off`.

## Routes that don't work today

| Route                                                                         | Status                            | Why                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_navigate` with `channel.routes`, then `window.dorkos.channel.emit()` | Server built, client half missing | The preview proxy injects the `window.dorkos.channel` shim (`services/workbench-serve/frame-inject.ts`), and grants, ingest and `<doc_events>` delivery exist. But the client mounts a doc channel only for `widget` documents, not `url`/`browser` ones, so the shim goes `offline` and `emit()` rejects. |
| postMessage to the parent                                                     | No                                | No client `message` listener starts a turn.                                                                                                                                                                                                                                                                |
| `fetch` to the DorkOS API from the page                                       | No                                | CORS refuses the preview origin and the opaque `null` origin (`http/cors-policy.ts`).                                                                                                                                                                                                                      |
| `canvas_send` / `canvas_patch_state`                                          | Wrong direction                   | They go agent to page.                                                                                                                                                                                                                                                                                     |
| `mcp_app` (`ui://`)                                                           | No                                | `tools/call` is refused and there is no `ui/message`.                                                                                                                                                                                                                                                      |
| dorkos-ui widget `kind:"agent"`                                               | Works, no custom HTML             | The right tool for a quick pick between labelled choices.                                                                                                                                                                                                                                                  |

## The cleaner path: the doc channel (DOR-2665)

Once the client mounts the doc-frame host bridge for browser documents, the
`window.dorkos.channel` handshake is the proper route:
`browser_navigate { url, channel: { routes: [{ id: "sends", on: "companion.*", to: "agent:owner", turn: { mode: "immediate", maxBatch: 1 } }] } }`,
then `approve_doc_route`, and the page calls `window.dorkos.channel.emit('companion.send', …)`.
It's better than the server hop because it's sanctioned rather than leaning on the no-login
default, DorkOS applies its own approval and limits, it works over a tunnel (where the server
can't reach `localhost:4242`), and it needs no session id.

**The companion is already ready for it.** `helper.js` checks
`window.dorkos.channel.status === 'ready'`. When it is, the page emits `companion.<type>` there
and marks the event `channel: true`, and the server skips its own forward, so nothing arrives
twice. Until then the status is `offline` and the server path does the work.

## Proxy notes (verified live)

- `browser_navigate` to the companion's URL is served from a per-port preview listener that keeps
  the path `/`, so relative URLs (`vc/state`, `vc/event`) resolve.
- WebSocket upgrades pass through the proxy. Polling stays for proxies that drop upgrades; that
  case is tested with a proxy that kills every upgrade.
- `browser_read_page`, `browser_click` and `browser_screenshot` work on companion pages. The
  outline names a button by its `title` before its text, which is why the Send button has no
  `title`.
- `get_ui_state` doesn't report the app's light or dark theme yet (DOR-2989), so set the theme
  with `vc theme` when you know it.
