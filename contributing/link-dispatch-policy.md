# Link Dispatch Policy

The client has one place that decides which link schemes may ever be opened, from any surface the app itself controls: `classifyLink` and `DISPATCHABLE_PROTOCOLS` in `apps/client/src/layers/shared/lib/link-navigation.ts`. This is a security boundary, not a UX nicety, so it is documented here rather than left to be inferred from the source.

**Since DOR-547 this is the only policy for links the app dispatches.** Markdown links in chat and in `MarkdownContent` used to be dispatched by first-party code that skipped this seam and therefore ran a different scheme list; they now confirm and then call `openExternalLink` like everything else — see [Markdown links](#markdown-links-dor-1272-dor-547) below. Links found inside error text ride the same anchor, via `LinkifiedText` — see [Links inside untrusted machine output](#links-inside-untrusted-machine-output). Three surfaces, one confirmation modal, one policy.

"Links the app dispatches" is the precise phrase, and the exclusions are named further down: **bare `<a href>` anchors** the browser follows without any of our code running (inventoried in DOR-924) and **direct `router.navigate` calls** are outside it. This page describes the seam every _programmatic_ open goes through, not every clickable thing on screen.

**A refusal is not silent.** Whenever `classifyLink` blocks a link, `openLink`/`openExternalLink` show one toast naming the scheme ("DorkOS doesn't open irc: links") before returning `false`. The message lives in the seam, in a single `reportRefusal`, precisely so no surface grows its own copy of the allowlist to restate — one did, and went stale the first time the list moved. Where a refusal is knowable **before** the person acts, it is shown before rather than after: `LinkSafetyModal` asks `classifyLink` when it opens and, for a refused link, explains itself and offers only "Copy link" instead of an "Open link" button whose one possible outcome is a refusal.

## The policy

`DISPATCHABLE_PROTOCOLS` (`link-navigation.ts`) is:

```ts
const DISPATCHABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:']);
```

`mailto:` and `tel:` are in for the same reason: a browser hands both to an OS handler from any page, so on the web and phone surfaces they genuinely go somewhere. `tel:` was added by DOR-547, when markdown links joined this policy — an agent writing `[support](tel:+15551234567)` produced a working link before, and refusing it would have taken that away for no safety gain. Both are declined by the desktop shell, which is [its own stricter layer](#the-desktop-shells-own-stricter-layer), not a disagreement with this list.

`isDispatchableProtocol` adds exactly one surface-dependent exception: `file:` is allowed when the _current page itself_ is `file:` (the `electron-vite preview` fallback, which loads the renderer straight off disk, so a relative in-app link inherits `file:`). From the normal `http:` cockpit, a `file:` target is refused — opening one would be a guaranteed no-op anyway, since browsers block `file:` navigation from an `http:` page.

Every other scheme is refused. `classifyLink` returns `{ kind: 'blocked', reason: 'unsupported-scheme' }`, and dispatch is a no-op: no navigation, no `window.open`, no tab.

## Why allowlist, not denylist

The policy used to be a denylist: everything except `javascript:`, `data:` and `vbscript:` was allowed, which meant `blob:`, `filesystem:`, `dorkos:` and `app:` all passed through untouched. That was tightened to an allowlist because the callers feeding this seam are not code this repo controls end to end — they're surfaces an agent or a remote MCP server can put arbitrary strings into (see below). A denylist only stops the schemes someone thought to name; an allowlist is safe against the one nobody has thought of yet. The comment on `DISPATCHABLE_PROTOCOLS` is explicit that a scheme should be added only when something in the app actually opens one, not preemptively.

The same reasoning is why this boundary should outlive today's specific mitigations. The MCP App iframe is sandboxed (see `MCP_APP_SANDBOX` in `McpAppFrame.tsx`) and gen-UI widgets are otherwise constrained, but those are defenses at a different layer that can change shape over time. The scheme allowlist doesn't depend on any of them holding; it's the seam that stays true regardless of what sandboxes an iframe or a widget renderer happens to have today.

## What this seam protects

`classifyLink` sits behind `openLink` and `openExternalLink`, the two ways the app's own code opens a link programmatically. The last known bypass of those helpers, the touch chip strip's embedded-mode `window.open`, was closed by DOR-921 and is listed below as one of the surfaces this seam protects. Two things deliberately do not route through it: bare `<a href>` anchors (React neutralizes `javascript:` on those itself; the ones fed by non-first-party data are inventoried in DOR-924) and direct `router.navigate` calls. Do not read this page as covering them. The seam's callers include untrusted or semi-trusted surfaces whose URLs the app did not author:

- **Every markdown link an agent writes** — `apps/client/src/layers/shared/ui/markdown-link.tsx`, behind the `LinkSafetyModal` confirmation. By volume this is the largest untrusted link surface in the product by a wide margin, and until DOR-547 it was the one that skipped the seam.
- **Gen-UI widget `url` actions** — `apps/client/src/layers/features/gen-ui/model/widget-context.tsx:266`, behind the `LinkSafetyModal` confirmation (spec D4). A widget is agent-rendered; its `url` action can name anything.
- **MCP App iframes** — `apps/client/src/layers/features/mcp-apps/ui/McpAppFrame.tsx:149`. An App's `ui/open-link` JSON-RPC call (`apps/client/src/layers/features/mcp-apps/model/bridge.ts:129`) sets a pending link that the same `LinkSafetyModal` confirms before it reaches `openExternalLink`.
- **MCP elicitation prompts** — `apps/client/src/layers/features/ask/ui/ElicitationPrompt.tsx`. An MCP server can name a scheme this seam refuses (an OAuth deep link like `myapp://`, say); the "I authorized this" affordance is gated on the link actually having opened, specifically so a refusal cannot be mistaken for success. Its inline message says what the refusal means for the authorization; the seam's own toast says why the link was refused. It used to restate the allowlist itself, and that copy was already out of date.
- **The canvas embedded browser's "Open in system browser" button** — `apps/client/src/layers/features/canvas/ui/CanvasBrowserContent.tsx:182`.
- **Touch chips in the Obsidian plugin** — `apps/client/src/layers/features/chat/ui/chips/TouchChipStrip.tsx`. A url chip's target is the agent's own `WebFetch` input, so it can name any scheme. The plugin has no canvas, so the chip hands the page to the browser through `openExternalLink`, and a refused scheme opens nothing and says so (the handler reports no outcome of its own, so there is nothing to gate on the return value). Until DOR-921 this branch called `window.open` directly and skipped the allowlist entirely.

  On every other surface the same chip **frames** the target in the canvas rather than opening it, which is a different question with its own answer: `classifyBrowserTarget` (`apps/client/src/layers/features/canvas/lib/browser-url.ts`) frames `http(s)`, serves `file:`, and renders a visible "can't be displayed for security reasons" message for every other scheme; a string that does not parse as a URL at all is treated as a cwd-relative serve path, which the server's sign-and-serve routes boundary-check against the working directory. Two gates, one per destination. Do not collapse them: routing the canvas branch through this seam would refuse the `file:` targets the canvas serves on purpose, and would replace a message the reader can see with a chip that does nothing when clicked.

Regular first-party UI (settings, the command palette, runtime-connect flows, the report-issue link) also routes through `openLink` / `openExternalLink`, but those hrefs are ones this codebase wrote, not ones an external actor supplied. The allowlist protects them the same way; they just aren't the reason it exists.

### The desktop shell's own, stricter layer

The Electron shell applies a second, independent policy on top of this one: `isWebLink` in `apps/desktop/src/main/window-manager.ts` allows only `http://` and `https://`, full stop — no `mailto:` or `tel:` exception. It gates both the `setWindowOpenHandler` and `will-navigate` guards, and the renderer's `open-external` bridge enforces the same function so there's no second rule to drift from the first. See [`desktop-app-development.md`](desktop-app-development.md#windows-plural) ("Windows, plural").

This is defense in depth, not redundancy: the client-side allowlist is what every surface (web app, Obsidian embed, desktop) shares, and the desktop shell narrows it further for its own outbound traffic. A scheme has to clear both gates to leave a desktop window; on the web app, only this page's policy applies.

**The honest posture on `mailto:` and `tel:` in the desktop app: they do not open, and the app says so.** Those two clear this page's allowlist and are then declined by the shell. Until DOR-547 that decline was invisible — `openExternal` resolved exactly as it does on success, so the renderer reported the link as opened and the person saw a click do nothing, which is the very symptom this ticket was filed about, reproduced one process later. Two things now cover it:

1. `openInBrowser` (`link-navigation.ts`) applies `isWebUrl` on the desktop path **before** dispatch, so the refusal is synchronous, the toast says "The desktop app opens web links only", and `openExternalLink`'s return value — which `ElicitationPrompt` and the OpenRouter sign-in flow both gate on — is honest on desktop.
2. The `open-external` IPC handler resolves `true`/`false` rather than `void`, and the seam reports a `false`. This catches a disagreement between the client-side mirror and the shell's own `isWebLink` (a `HTTP://` spelling passes one and fails the other) instead of letting it fall through as silent success. An older preload resolves `undefined`, which is treated as "no answer", not as a decline — a version-skewed host stays quiet rather than accusing itself.

Neither is a substitute for the other: the first keeps the return value honest, the second keeps the two predicates from drifting apart unnoticed.

## Markdown links (DOR-1272, DOR-547)

**Markdown links in chat and in static `MarkdownContent` go through `classifyLink` like everything else.** Two different pieces of code touch the href, and it is worth keeping them apart. Streamdown (`streamdown` npm package, pinned `2.5.0`) parses and **sanitizes** it first, under its own sanitizer, so some schemes never become an anchor at all. Rendering the surviving anchor and **dispatching** a click is first-party code as of DOR-1272: every Streamdown instance in the app — chat's `StreamingText` and every `MarkdownContent` caller, unconditionally — is handed `components={{ a: MarkdownLink }}` (`apps/client/src/layers/shared/ui/markdown-link.tsx`), so Streamdown's own bundled `a` component never mounts anywhere in DorkOS. DOR-547 pointed that dispatch at `openExternalLink`, which is what makes this page's policy the whole policy.

**`onLinkCheck` is not a residual, and here is the resolution in full.** DOR-547's ticket body flagged Streamdown's `onLinkCheck` hook as a second bypass that an `onConfirm` override could not close. That was written against the pre-DOR-1272 architecture, where Streamdown's own `a` component mounted and consulted its `linkSafety` context. It no longer does: `components={{ a: MarkdownLink }}` is passed unconditionally at both Streamdown call sites (`StreamingText`, `MarkdownContent`), so Streamdown's anchor never mounts anywhere in DorkOS, and neither `onLinkCheck` nor `renderModal` nor any other `linkSafety` field is passed by any caller in the repo — grep for `linkSafety` and `onLinkCheck` and you will find them only in `node_modules` and in prose like this. There is nothing left for that hook to intercept.

This is not an optional hardening. Streamdown's built-in `linkSafety` handling renders an hrefless `<button>` in the anchor's place whenever it is enabled — and it **defaults to `{ enabled: true }` inside Streamdown itself**, so a caller that never mentioned `linkSafety` at all still got the button; there never was a real "off" path through Streamdown's own component (round 1 of DOR-1272 shipped a `MarkdownContent` `linkSafety` prop believing there was one — wrong, and removed). `MarkdownLink` is a real `<a href>` instead: a plain, unmodified left click still opens `LinkSafetyModal` before anything is dispatched.

**A modified click (cmd/ctrl/shift/alt, or a non-primary button) is left to the browser only when the href is an absolute `http:`/`https:` URL.** Every other case — `tel:`, `mailto:`, an `irc:`/`ircs:`/`xmpp:` autolink, and any relative or protocol-relative href (`/path`, `//host/path`, deliberately not resolved against the page) — still confirms even when modified, because a modified click on one of those would otherwise reach an OS protocol handler with zero warning; `window.open`, by contrast, only ever opens a browser tab. `MarkdownLink` checks this itself (mirroring, not importing, the desktop shell's `isWebLink` below — different process, different bundle).

That check is **deliberately narrower than `DISPATCHABLE_PROTOCOLS`, and is not a second copy of it.** It does not answer "may DorkOS open this?" — `classifyLink` does, on the confirmed path. It answers "may the browser have this click without asking?", and only a scheme whose worst case is a new browser tab qualifies. `mailto:` and `tel:` dispatch through the seam yet still confirm here, because a cmd-click that silently opened a mail composer or a dialer is not what the reader asked for.

**The confirmed path dispatches through `openExternalLink`** — the same call the other two `LinkSafetyModal` call sites (`widget-context.tsx`, `McpAppFrame.tsx`) make. It was a raw `window.open` until DOR-547, and the reason it was is worth keeping: `openExternalLink` used to refuse silently, so rerouting through it would have turned "you confirmed, now open" into nothing happening, with no way to tell why. The refusal message came first for exactly that reason; the reroute second. `openExternalLink` rather than `openLink`, because the modal's contract is "this leaves what you are looking at" — a markdown link naming one of our own routes opens a tab rather than navigating the reply out from under the reader.

Streamdown's pipeline runs two rehype plugins, and only one of them gates schemes: `rehype-sanitize` (with `hast-util-sanitize`'s default GitHub-style schema, extended with `tel:`) strips a disallowed `href`; `rehype-harden` runs after it configured with `allowedProtocols: ["*"]`, so it gates nothing here and only swaps the now-hrefless anchor for inert blocked text. The schema's `protocols.href` is:

```
http, https, irc, ircs, mailto, xmpp, tel
```

A rendered probe against the pinned `streamdown@2.5.0` confirms the practical effect: `http:`, `https:`, `mailto:`, `irc:`, `ircs:`, `xmpp:` and `tel:` links render as clickable; `javascript:`, `data:`, `vbscript:`, `file:`, `blob:` and anything else (e.g. `ftp:`) are stripped to inert, unclickable text.

The sanitizer is therefore **looser** than this seam on exactly three schemes: `irc:`, `ircs:` and `xmpp:` render as real anchors and are then refused at dispatch, out loud, since DOR-547. (`tel:` was the fourth; it joined `DISPATCHABLE_PROTOCOLS` instead of being refused — see [The policy](#the-policy).) The refusal is the accepted cost of one uniform rule: those three are essentially never emitted by an agent in chat, and a visible "DorkOS doesn't open irc: links" is a better answer than two policies that disagree.

The two gates compose in one direction: the sanitizer can only ever remove an anchor before this seam sees it, and the seam can only ever refuse an href the sanitizer already passed. Neither can widen the other.

`MarkdownLink`'s own refusal of `file:`/`javascript:` is therefore **defense in depth, not a reachable path** — and it is worth being exact about why, because an earlier draft of this page justified it with a claim that is false. It said `LinkifiedText` feeds `MarkdownLink` unsanitized machine output; it does not. `LinkifiedText`'s URL scanner only ever emits `http(s)` matches (that is the point of the section below — every anchor's label is its own normalized href), so it cannot hand this component a `file:` href either. Both of this component's callers are gated upstream today. The gate stays because "both callers happen to be safe right now" is a property of two other files, not of this one, and `MarkdownLink` is the app's only markdown anchor: a third caller is a one-line change, and the tests that pin these refusals are what make that change safe rather than silent.

**One correction worth flagging plainly: `blob:` is not permitted.** The framing that produced DOR-547 (and, until this page landed, a comment on `DISPATCHABLE_PROTOCOLS`) asserted Streamdown's sanitizer lets `blob:` through, and credited `rehype-harden` with the gating. A live render check shows otherwise on both counts: `blob:` hrefs are stripped exactly like `javascript:`/`data:`, and `rehype-sanitize` is the plugin doing it. So unifying the policies cost `blob:` nothing — it never worked here.

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

`mailto:` and `tel:` are the two deliberate exceptions to step 2, and are only exceptions because the desktop app loses nothing by it: neither has ever opened from a desktop window, through this seam or the raw `window.open` that preceded it, so leaving the shell alone preserves the status quo there while the web and phone surfaces keep a link that works. What makes the carve-out acceptable rather than merely convenient is that the gap is now **reported** on desktop rather than swallowed — see [the desktop shell's own, stricter layer](#the-desktop-shells-own-stricter-layer). A scheme that would be **newly** reachable on desktop does not get that carve-out; do both edits.

There is a third edit whenever you take the carve-out: `isWebUrl` in `link-navigation.ts` is the client-side mirror of the shell's `isWebLink`, and it is what decides which schemes get refused on the desktop path before dispatch. If the shell widens, widen the mirror in the same change, or the desktop refuses a link the shell would have opened.

## Related

- [`desktop-app-development.md`](desktop-app-development.md#windows-plural) — the desktop shell's `http(s)`-only outbound policy, which sits on top of this one.
- `apps/client/src/layers/shared/lib/link-navigation.ts` — the contract itself (`classifyLink`, `DISPATCHABLE_PROTOCOLS`, `openLink`, `openExternalLink`).
- `apps/client/src/layers/shared/ui/link-safety-modal.tsx` — the shared confirmation surface every untrusted link renders through. Its "Copy link" is the reason a refused link still gets a modal rather than being turned away at the click: it is the one useful thing left for a link DorkOS will not open.
- `apps/client/src/layers/shared/ui/markdown-link.tsx` — the real-anchor `a` override every Streamdown instance in the app uses, unconditionally, instead of Streamdown's own button-rendering `linkSafety` handling (DOR-1272), and the caller that put markdown links back on this page's policy (DOR-547).
- `apps/client/src/layers/shared/ui/linkified-text.tsx` — the linkify-only renderer for untrusted machine output (error messages), which reuses `MarkdownLink` for the anchor itself.
