# Link Dispatch Policy

The client has one place that decides which link schemes may ever be opened, from any surface the app itself controls: `classifyLink` and `DISPATCHABLE_PROTOCOLS` in `apps/client/src/layers/shared/lib/link-navigation.ts`. This is a security boundary, not a UX nicety, so it is documented here rather than left to be inferred from the source.

**It does not cover chat markdown links.** Those are rendered and dispatched by Streamdown under a separate, looser policy — see [The chat markdown divergence](#the-chat-markdown-divergence-dor-547) below. Read this page as describing one of two link policies in the app, not the only one.

## The policy

`DISPATCHABLE_PROTOCOLS` (`link-navigation.ts`) is:

```ts
const DISPATCHABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);
```

`isDispatchableProtocol` adds exactly one surface-dependent exception: `file:` is allowed when the _current page itself_ is `file:` (the `electron-vite preview` fallback, which loads the renderer straight off disk, so a relative in-app link inherits `file:`). From the normal `http:` cockpit, a `file:` target is refused — opening one would be a guaranteed no-op anyway, since browsers block `file:` navigation from an `http:` page.

Every other scheme is refused. `classifyLink` returns `{ kind: 'blocked', reason: 'unsupported-scheme' }`, and dispatch is a no-op: no navigation, no `window.open`, no tab.

## Why allowlist, not denylist

The policy used to be a denylist: everything except `javascript:`, `data:` and `vbscript:` was allowed, which meant `blob:`, `filesystem:`, `dorkos:` and `app:` all passed through untouched. That was tightened to an allowlist because the callers feeding this seam are not code this repo controls end to end — they're surfaces an agent or a remote MCP server can put arbitrary strings into (see below). A denylist only stops the schemes someone thought to name; an allowlist is safe against the one nobody has thought of yet. The comment on `DISPATCHABLE_PROTOCOLS` is explicit that a scheme should be added only when something in the app actually opens one, not preemptively.

The same reasoning is why this boundary should outlive today's specific mitigations. The MCP App iframe is sandboxed (see `MCP_APP_SANDBOX` in `McpAppFrame.tsx`) and gen-UI widgets are otherwise constrained, but those are defenses at a different layer that can change shape over time. The scheme allowlist doesn't depend on any of them holding; it's the seam that stays true regardless of what sandboxes an iframe or a widget renderer happens to have today.

## What this seam protects

`classifyLink` sits behind `openLink` and `openExternalLink`, the two ways the app's own code opens a link programmatically. The last known bypass of those helpers, the touch chip strip's embedded-mode `window.open`, was closed by DOR-921 and is listed below as one of the surfaces this seam protects. Two things deliberately do not route through it: bare `<a href>` anchors (React neutralizes `javascript:` on those itself; the ones fed by non-first-party data are inventoried in DOR-924) and direct `router.navigate` calls. Do not read this page as covering them. The seam's callers include untrusted or semi-trusted surfaces whose URLs the app did not author:

- **Gen-UI widget `url` actions** — `apps/client/src/layers/features/gen-ui/model/widget-context.tsx:266`, behind the `LinkSafetyModal` confirmation (spec D4). A widget is agent-rendered; its `url` action can name anything.
- **MCP App iframes** — `apps/client/src/layers/features/mcp-apps/ui/McpAppFrame.tsx:149`. An App's `ui/open-link` JSON-RPC call (`apps/client/src/layers/features/mcp-apps/model/bridge.ts:129`) sets a pending link that the same `LinkSafetyModal` confirms before it reaches `openExternalLink`.
- **MCP elicitation prompts** — `apps/client/src/layers/features/chat/ui/tools/ElicitationPrompt.tsx:120`. An MCP server can name a scheme this seam refuses (an OAuth deep link like `myapp://`, say); the "I authorized this" affordance is gated on the link actually having opened, specifically so a refusal cannot be mistaken for success.
- **The canvas embedded browser's "Open in system browser" button** — `apps/client/src/layers/features/canvas/ui/CanvasBrowserContent.tsx:182`.
- **Touch chips in the Obsidian plugin** — `apps/client/src/layers/features/chat/ui/chips/TouchChipStrip.tsx`. A url chip's target is the agent's own `WebFetch` input, so it can name any scheme. The plugin has no canvas, so the chip hands the page to the browser through `openExternalLink`, and a refused scheme is a no-op (nothing in that handler reports an outcome, so there is nothing to gate on the return value). Until DOR-921 this branch called `window.open` directly and skipped the allowlist entirely.

  On every other surface the same chip **frames** the target in the canvas rather than opening it, which is a different question with its own answer: `classifyBrowserTarget` (`apps/client/src/layers/features/canvas/lib/browser-url.ts`) frames `http(s)`, serves `file:`, and renders a visible "can't be displayed for security reasons" message for every other scheme; a string that does not parse as a URL at all is treated as a cwd-relative serve path, which the server's sign-and-serve routes boundary-check against the working directory. Two gates, one per destination. Do not collapse them: routing the canvas branch through this seam would refuse the `file:` targets the canvas serves on purpose, and would replace a message the reader can see with a chip that does nothing when clicked.

Regular first-party UI (settings, the command palette, runtime-connect flows, the report-issue link) also routes through `openLink` / `openExternalLink`, but those hrefs are ones this codebase wrote, not ones an external actor supplied. The allowlist protects them the same way; they just aren't the reason it exists.

### The desktop shell's own, stricter layer

The Electron shell applies a second, independent policy on top of this one: `isWebLink` in `apps/desktop/src/main/window-manager.ts` allows only `http://` and `https://`, full stop, no `mailto:` exception. It gates both the `setWindowOpenHandler` and `will-navigate` guards, and the renderer's `open-external` bridge enforces the same function so there's no second rule to drift from the first. See [`desktop-app-development.md`](desktop-app-development.md#windows-plural) ("Windows, plural").

This is defense in depth, not redundancy: the client-side allowlist is what every surface (web cockpit, Obsidian embed, desktop) shares, and the desktop shell narrows it further for its own outbound traffic. A scheme has to clear both gates to leave a desktop window; on the web cockpit, only this page's policy applies.

## The chat markdown divergence (DOR-547)

**Markdown links in chat and in static `MarkdownContent` do not go through `classifyLink` at all.** Streamdown (`streamdown` npm package, pinned `2.5.0`) parses and sanitizes the `href`, under Streamdown's own sanitizer, not this module's allowlist — the scheme gating described below is all Streamdown's. Rendering the resulting anchor and dispatching a click is a different story: a surface that opts into `linkSafety` (chat, and any `MarkdownContent` caller that passes `linkSafety`) does NOT use Streamdown's own bundled `a` component. Streamdown's built-in `linkSafety` handling renders a `<button>` in the anchor's place — no `href`, so no hover preview, no cmd/middle-click into a tab, no native "Copy Link Address" (DOR-1272). `MarkdownLink` (`apps/client/src/layers/shared/ui/markdown-link.tsx`) replaces it via `components={{ a: MarkdownLink }}`: a real `<a href>` whose plain-left-click handler still opens `LinkSafetyModal` before dispatching `window.open`, while a modified click (cmd/ctrl/shift/alt, middle button) is left to the browser untouched. A surface that leaves `linkSafety` off gets Streamdown's own plain anchor, unchanged.

Streamdown's pipeline runs two rehype plugins, and only one of them gates schemes: `rehype-sanitize` (with `hast-util-sanitize`'s default GitHub-style schema, extended with `tel:`) strips a disallowed `href`; `rehype-harden` runs after it configured with `allowedProtocols: ["*"]`, so it gates nothing here and only swaps the now-hrefless anchor for inert blocked text. The schema's `protocols.href` is:

```
http, https, irc, ircs, mailto, xmpp, tel
```

A rendered probe against the pinned `streamdown@2.5.0` confirms the practical effect: `http:`, `https:`, `mailto:`, `irc:`, `ircs:`, `xmpp:` and `tel:` links render as clickable; `javascript:`, `data:`, `vbscript:`, `file:`, `blob:` and anything else (e.g. `ftp:`) are stripped to inert, unclickable text.

That means chat markdown is **looser** than this seam on `irc:`, `ircs:`, `xmpp:` and `tel:` — schemes `DISPATCHABLE_PROTOCOLS` refuses outright. Reconciling the two policies is tracked separately as DOR-547; until then, treat them as knowingly divergent rather than assuming one uniform rule covers every link surface in the app.

**One correction worth flagging plainly: `blob:` is not actually permitted.** The framing that produced this ticket (and, until this page landed, a comment on `DISPATCHABLE_PROTOCOLS`) asserted Streamdown's sanitizer lets `blob:` through, and credited `rehype-harden` with the gating. A live render check shows otherwise on both counts: `blob:` hrefs are stripped exactly like `javascript:`/`data:`, and `rehype-sanitize` is the plugin doing it. DOR-547's reconciliation should start from this page's verified list.

## Adding a scheme

Two edits, or the scheme silently half-works:

1. Add it to `DISPATCHABLE_PROTOCOLS` and extend `apps/client/src/layers/shared/lib/__tests__/link-navigation.test.ts`, which pins the refusals.
2. Widen `isWebLink` in `apps/desktop/src/main/window-manager.ts` too, or the scheme dispatches on the web cockpit and no-ops in every desktop window (it gates `setWindowOpenHandler`, `will-navigate`, and the `open-external` bridge).

## Related

- [`desktop-app-development.md`](desktop-app-development.md#windows-plural) — the desktop shell's `http(s)`-only outbound policy, which sits on top of this one.
- `apps/client/src/layers/shared/lib/link-navigation.ts` — the contract itself (`classifyLink`, `DISPATCHABLE_PROTOCOLS`, `openLink`, `openExternalLink`).
- `apps/client/src/layers/shared/ui/link-safety-modal.tsx` — the shared confirmation surface both policies render through.
- `apps/client/src/layers/shared/ui/markdown-link.tsx` — the real-anchor `a` override chat and `linkSafety`-opted-in `MarkdownContent` callers use instead of Streamdown's own button-rendering `linkSafety` handling (DOR-1272).
