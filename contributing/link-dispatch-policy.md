# Link Dispatch Policy

The client has one place that decides which link schemes may ever be opened, from any surface the app itself controls: `classifyLink` and `DISPATCHABLE_PROTOCOLS` in `apps/client/src/layers/shared/lib/link-navigation.ts`. This is a security boundary, not a UX nicety, so it is documented here rather than left to be inferred from the source.

**It does not cover chat markdown links.** Those are rendered and dispatched by Streamdown under a separate, looser policy — see [The chat markdown divergence](#the-chat-markdown-divergence-dor-547) below. Read this page as describing one of two link policies in the app, not the only one.

**Nor does it cover links found inside error text.** Those are produced by `LinkifiedText`, which does its own URL detection and then reuses `MarkdownLink` — see [Links inside untrusted machine output](#links-inside-untrusted-machine-output) below. Three surfaces, one confirmation modal.

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

**Markdown links in chat and in static `MarkdownContent` do not go through `classifyLink` at all.** Streamdown (`streamdown` npm package, pinned `2.5.0`) parses and sanitizes the `href`, under Streamdown's own sanitizer, not this module's allowlist — the scheme gating described below is all Streamdown's. Rendering the resulting anchor and dispatching a click is a different story, and as of DOR-1272 it is **first-party code, not Streamdown's**: every Streamdown instance in the app — chat's `StreamingText` and every `MarkdownContent` caller, unconditionally — is handed `components={{ a: MarkdownLink }}` (`apps/client/src/layers/shared/ui/markdown-link.tsx`), so Streamdown's own bundled `a` component never mounts anywhere in DorkOS.

This is not an optional hardening. Streamdown's built-in `linkSafety` handling renders an hrefless `<button>` in the anchor's place whenever it is enabled — and it **defaults to `{ enabled: true }` inside Streamdown itself**, so a caller that never mentioned `linkSafety` at all still got the button; there never was a real "off" path through Streamdown's own component (round 1 of DOR-1272 shipped a `MarkdownContent` `linkSafety` prop believing there was one — wrong, and removed). `MarkdownLink` is a real `<a href>` instead: a plain, unmodified left click still opens `LinkSafetyModal` before dispatching `window.open`.

**A modified click (cmd/ctrl/shift/alt, or a non-primary button) is left to the browser only when the href is an absolute `http:`/`https:` URL.** Every other case — `tel:`, `mailto:`, an `irc:`/`ircs:`/`xmpp:` autolink, and any relative or protocol-relative href (`/path`, `//host/path`, deliberately not resolved against the page) — still confirms even when modified, because a modified click on one of those would otherwise reach an OS protocol handler with zero warning; `window.open`, by contrast, only ever opens a browser tab. `MarkdownLink` checks this itself (mirroring, not importing, the desktop shell's `isWebLink` below — different process, different bundle).

**Why the confirmed path dispatches with a raw `window.open` rather than `openLink`/`openExternalLink`.** Both other `LinkSafetyModal` call sites (`widget-context.tsx`, `McpAppFrame.tsx`) route their confirmed link through `openExternalLink`. `MarkdownLink` deliberately does not: `openExternalLink` refuses (silently, no-op) anything outside `DISPATCHABLE_PROTOCOLS` — which is exactly the `irc:`/`ircs:`/`xmpp:`/`tel:` set this section documents as reachable here. Routing through it would turn "you confirmed, now open" into nothing happening for any of those, which is worse than today's raw dispatch. Reconciling the two policies is still tracked as DOR-547; until then, `MarkdownLink` intentionally keeps the wider, Streamdown-sanitizer-gated scheme set working end to end rather than silently narrowing it by rerouting through the stricter seam.

Streamdown's pipeline runs two rehype plugins, and only one of them gates schemes: `rehype-sanitize` (with `hast-util-sanitize`'s default GitHub-style schema, extended with `tel:`) strips a disallowed `href`; `rehype-harden` runs after it configured with `allowedProtocols: ["*"]`, so it gates nothing here and only swaps the now-hrefless anchor for inert blocked text. The schema's `protocols.href` is:

```
http, https, irc, ircs, mailto, xmpp, tel
```

A rendered probe against the pinned `streamdown@2.5.0` confirms the practical effect: `http:`, `https:`, `mailto:`, `irc:`, `ircs:`, `xmpp:` and `tel:` links render as clickable; `javascript:`, `data:`, `vbscript:`, `file:`, `blob:` and anything else (e.g. `ftp:`) are stripped to inert, unclickable text.

That means chat markdown is **looser** than this seam on `irc:`, `ircs:`, `xmpp:` and `tel:` — schemes `DISPATCHABLE_PROTOCOLS` refuses outright. Reconciling the two policies is tracked separately as DOR-547; until then, treat them as knowingly divergent rather than assuming one uniform rule covers every link surface in the app.

**One correction worth flagging plainly: `blob:` is not actually permitted.** The framing that produced this ticket (and, until this page landed, a comment on `DISPATCHABLE_PROTOCOLS`) asserted Streamdown's sanitizer lets `blob:` through, and credited `rehype-harden` with the gating. A live render check shows otherwise on both counts: `blob:` hrefs are stripped exactly like `javascript:`/`data:`, and `rehype-sanitize` is the plugin doing it. DOR-547's reconciliation should start from this page's verified list.

### The right-click on a link inside a room message (DOR-1272)

A room message's whole row is wrapped in `EntryActionMenu`, whose desktop trigger is Radix's `ContextMenuTrigger` (`Message.Root`, the one row both a channel and a session draw — `features/conversation/ui/message/MessageRoot.tsx`) — it `preventDefault()`s `contextmenu` unconditionally so a right-click anywhere on the row opens DorkOS's own action menu (Reply in thread, Copy text, and so on), which has no copy-link item. Without a carve-out, that would also swallow a right-click on a link inside the message, leaving the browser's native "Copy Link Address" unreachable there specifically. `MarkdownLink` stops that: its own `onContextMenu` calls `event.stopPropagation()`, so the event never reaches the row's trigger and the browser's native link menu wins instead. React's synthetic events walk the React tree, so this only affects the link's own ancestors — right-clicking anywhere else on the row still opens the row menu as before. The identical `contextmenu` DOM event fires for the keyboard path (Shift+F10 / the ContextMenu key on a focused link) too, so a keyboard user gets the same browser link menu there — intended, not a gap. Pinned in `RoomMessage.test.tsx`.

**Desktop Electron scope note.** The Electron shell registers no `context-menu` handler on any `webContents` at all (only `apps/desktop/src/main/tray.ts`, the system tray icon — unrelated). It shows no native context menu for anything in the renderer, links included, on any surface — a pre-existing gap, unrelated to this fix, tracked separately.

## Links inside untrusted machine output

Error text is not prose and is not ours: a runtime error can be authored by a remote provider, and it routinely carries the one address that would fix the problem ("add credits at ..."). It used to reach the screen as an inert text node, so the address had to be retyped by hand.

`apps/client/src/layers/shared/ui/linkified-text.tsx` renders those strings: **literal text, with bare `http:`/`https:` URLs turned into anchors, and nothing else interpreted.** It is deliberately NOT markdown, and that is the load-bearing part of this section:

- **Fidelity.** Error strings contain `*`, `_`, backticks, `#`, `-`, `>`, JSON braces and newlines all the time. Markdown would restyle and restructure exactly the string a person is reading literally.
- **No label/href divergence.** A markdown-rendered error could produce `[https://dorkos.ai/settings](https://attacker.example)` — a link whose visible label lies about where it goes, drawn inside DorkOS's own error chrome. Here every anchor's label is its **normalized** href, so the mismatch is not expressible. The URL scanner stops at `[` and `]` for the same reason: without that, `](` fused two hosts into one match.

  **Normalized is the load-bearing word, and showing the raw string was not enough.** The browser rewrites an href before it requests it, so a label copied character-for-character from the provider can still name a different host than the one it opens: `https://dоrkos.ai` with a Cyrillic `о` (U+043E) is fetched as `https://xn--drkos-jye.ai`, `dorkos.ai。evil.example` collapses to the host `dorkos.ai.evil.example` under UTS46, and a U+202E override renders a `.exe` path as `.png`. `LinkifiedText` therefore renders `new URL(match).href` as both the label and the destination, so punycode and percent-encoding are visible to the reader. One shape survives normalization — `https://dorkos.ai@evil.example/x` normalizes to itself while resolving to `evil.example` — so URLs carrying userinfo are refused outright and stay plain text.

- **No images, no HTML, no `allowedTags` question.** A markdown-rendered error could fire a tracking beacon by carrying an image. This surface has no element vocabulary at all.

The anchor itself is not reinvented: `LinkifiedText` renders `MarkdownLink`, so the confirmation modal, `rel`, `target="_blank"` and the modified-click policy are identical to the markdown surfaces above, and the desktop shell's `setWindowOpenHandler` routes them the same way.

Current callers: `ErrorMessageBlock` (every chat-surfaced runtime error), `TunnelError`, `PackageErrorState`, `AdapterCardError` and `RouteErrorFallback`. When adding one, pass the raw string — do not pre-format it.

## Adding a scheme

Two edits, or the scheme silently half-works:

1. Add it to `DISPATCHABLE_PROTOCOLS` and extend `apps/client/src/layers/shared/lib/__tests__/link-navigation.test.ts`, which pins the refusals.
2. Widen `isWebLink` in `apps/desktop/src/main/window-manager.ts` too, or the scheme dispatches on the web cockpit and no-ops in every desktop window (it gates `setWindowOpenHandler`, `will-navigate`, and the `open-external` bridge).

## Related

- [`desktop-app-development.md`](desktop-app-development.md#windows-plural) — the desktop shell's `http(s)`-only outbound policy, which sits on top of this one.
- `apps/client/src/layers/shared/lib/link-navigation.ts` — the contract itself (`classifyLink`, `DISPATCHABLE_PROTOCOLS`, `openLink`, `openExternalLink`).
- `apps/client/src/layers/shared/ui/link-safety-modal.tsx` — the shared confirmation surface both policies render through.
- `apps/client/src/layers/shared/ui/markdown-link.tsx` — the real-anchor `a` override every Streamdown instance in the app uses, unconditionally, instead of Streamdown's own button-rendering `linkSafety` handling (DOR-1272).
- `apps/client/src/layers/shared/ui/linkified-text.tsx` — the linkify-only renderer for untrusted machine output (error messages), which reuses `MarkdownLink` for the anchor itself.
