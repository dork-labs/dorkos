---
slug: devtools-bridge
id: 260711-142034
created: 2026-07-11
status: specified
---

# DevTools Bridge — Ideation (pointer)

**This is a v2 fast-follow to the Right-Panel Workbench (DOR-211). It does not
re-ideate — the design context lives in the parent spec.** This file exists only
to anchor the provenance chain; the real thinking is in
[`02-specification.md`](./02-specification.md).

## Where this came from

- **Parent ideation:** [`specs/right-panel-workbench/01-ideation.md`](../right-panel-workbench/01-ideation.md)
  - **Decision D11** — "DevTools bridge deferred to v2 (tracked DOR-213), v1
    browser pre-architected for later attach."
  - **Decision round 2, item 2** — "The v1 browser ships as a plain preview; the
    agent-self-verification bridge (console/network/screenshot exposed to the
    agent) is deferred to v2 and tracked in Linear… The v1 browser must be
    architected so the bridge attaches cleanly later (proxy route already sees
    traffic; console capture is an injected script on served pages) — no v1
    rework."
  - **Research §4, "Not-thinking-of opportunities"** — "Chrome DevTools MCP-style
    bridge (browser pane exposes console/network/screenshot back to the agent —
    differentiated and on-thesis)." Modeled on Google's `chrome-devtools-mcp`.
- **Parent spec:** [`specs/right-panel-workbench/02-specification.md`](../right-panel-workbench/02-specification.md)
  Non-Goals: "DevTools bridge (console/network/screenshot → agent) — **fast-follow
  DOR-213 (v2)**; v1 browser is pre-architected for it."
- **Shipped v1 (the seam this attaches to):** PR #144 (DOR-216), the embedded
  browser + signed-URL serve/localhost-proxy + opaque-origin sandbox. ADR
  [`260708-185519`](../../decisions/260708-185519-local-html-serving-origin-isolation.md).
  The component `CanvasBrowserContent.tsx` already carries the DevTools-bridge
  seam comment.

## The problem in one sentence

Today the agent can edit frontend code and open a preview (v1 browser), but it
cannot **see** the result — console errors, failed requests, the rendered page —
so a human still has to relay "it's throwing a TypeError" back to it. This closes
that loop: the agent reads its own console/network/screenshot and fixes without
the human in the middle.

## What is already decided (carried into SPECIFY, not re-litigated)

- The bridge is **scoped to workbench-served and workbench-proxied pages only**
  (local HTML files + localhost dev servers). Arbitrary external sites cannot be
  instrumented from an opaque-origin iframe — this is a hard browser boundary,
  not a scoping choice.
- **No v1 rework.** The serve route (`handleServe`) and localhost proxy
  (`proxyToLocalhost`) already see every byte of preview traffic; the
  opaque-origin sandbox (`WORKBENCH_SANDBOX_ISOLATED`) is unchanged.
- The v1 **origin-isolation security model is inviolable** (ADR 260708-185519):
  opaque-origin sandbox (no `allow-same-origin`), signed short-lived serve/proxy
  URLs, `Referrer-Policy: no-referrer`. The bridge must not weaken any of it.

**Next step:** the specification. See [`02-specification.md`](./02-specification.md).
