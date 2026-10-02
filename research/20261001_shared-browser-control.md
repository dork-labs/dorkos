# A visible browser agents can control

Date: 2026-10-01. Flow stage: IDEATE. The operator agreed to the managed Playwright direction and monorepo package boundary after this research; production design remains subject to the prototype findings.

## Recommendation

Build a DorkOS-owned Chromium browser using the Playwright library. Display the **actual controlled tab** in the Browser panel through a live stream, with human input and agent tools reaching the same page. Use Playwright for normal automation and CDP selectively for diagnostics or input gaps. Reuse the existing signed-in browser setup rather than designing a second login system.

This is a research recommendation, not a verified implementation. Its largest uncertainty is the quality of the remote browser experience: accessibility, text selection, clipboard, IME, phone input and tunnel latency. A focused prototype must resolve those before a full implementation plan is frozen.

## What the current code does

There are already two separate paths:

1. **Visible previews:** `CanvasBrowserContent.tsx` renders an iframe. Served HTML and preview-listener pages receive an injected shim. The session browser seat routes actions to the selected client/document and waits for a correlated answer. All three production agent runtimes reach the common capability implementation.
2. **Full agent automation:** `packages/shared/src/agent-browser.ts` supplies a pinned `@playwright/mcp@0.0.82` stdio preset with `--isolated --headless --storage-state`. Each agent gets a separate browser seeded from saved sign-ins. That browser is not the iframe the person sees.

The preview tools already include click, type, press, scroll, wait, page outline, screenshot, console/network reads and recording. Their fidelity is deliberately limited:

- `devtools-driving.ts` uses `el.click()`, value setters, input/change events and synthetic keyboard events. It does not implement Playwright's actionability checks, auto-waiting, shadow-DOM locators or full accessible-name computation.
- `devtools-shim.ts` wraps console and fetch/XHR and uses injected `html-to-image` for screenshots. This is DOM rasterization, not the browser compositor; page scripts can affect the evidence.
- External pages and direct uninstrumented previews cannot be driven. Sites may refuse framing. Top-level navigation can leave the instrumented surface.
- A mounted interactive client is needed for the existing screenshot/action round trip. Server-owned Canvas metadata does not mean the browser execution itself is server-owned.
- Desktop capture uses `webContents.capturePage()` for an app-window screenshot. This is not a dedicated browser engine or browser-control transport. The current Browser panel still uses the React iframe.

Relevant source:

- [Browser view](../apps/client/src/layers/features/canvas/ui/CanvasBrowserContent.tsx)
- [Client bridge](../apps/client/src/layers/features/canvas/model/use-devtools-bridge.ts)
- [Shared browser capability declarations](../apps/server/src/services/session/browser-seat/ui-capabilities.ts)
- [Driving implementation](../apps/server/src/services/workbench-serve/devtools-driving.ts)
- [Injected capture shim](../apps/server/src/services/workbench-serve/devtools-shim.ts)
- [Browser action protocol](../apps/server/src/services/session/browser-seat/act-protocol.ts)
- [Signed-in browser preset](../packages/shared/src/agent-browser.ts)
- [CLI profile/state implementation](../packages/cli/src/lib/agent-browser/)
- [Desktop app capture](../apps/desktop/src/main/capture/index.ts)

## The three choices

| Choice                                               | Strength                                                                           | Cost and limitation                                                                                                            | Choose it when                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **1. Managed Chromium + Playwright + shared stream** | Full browser automation and one visible page; applicable to web, desktop and phone | Chromium installation/lifecycle, memory, remote-input and accessibility work                                                   | DorkOS should own the complete browser experience across its primary surfaces |
| **2. Electron WebContentsView + CDP/native APIs**    | Native embedded desktop browser, real pixels, normal human interaction             | Requires a new desktop surface and layout/IPC/session handling; web and phone still need streaming; Electron/CDP compatibility | Native desktop browsing is the primary objective                              |
| **3. Opt-in existing Chrome tab via extension**      | Existing sign-ins, tabs and browser extensions                                     | Extension setup, personal-tab authority, Chrome/Edge dependency; weaker in-app ownership and sharing                           | Acting in the person's existing browser matters most                          |

### 1. Managed Chromium

The server owns a context and stable tab identity. The Browser panel subscribes to that tab's frames. Agent selectors and coordinate actions, human mouse/keyboard input, screenshots, console/network evidence and recordings all refer to that tab. Multiple viewers watch one viewport; resizing one viewer must not silently change everybody's page layout.

Playwright provides locators and [actionability/auto-waiting](https://playwright.dev/docs/actionability). Its [Page API](https://playwright.dev/docs/api/class-page) provides screenshots, console events, navigation and browser interactions. The current [screencast API](https://playwright.dev/docs/api/class-screencast#screencast-start), introduced in 1.59, can deliver JPEG frames with viewport metadata and also record video. The repo's e2e dependency resolves Playwright 1.63.0, but the server does not thereby acquire a production browser dependency. Pinning, installation, updates and supported deployments remain design work.

Use the public screencast API first; assess a frame transport with backpressure and latest-frame delivery. CDP's [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) and [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) domains are useful lower-level capabilities when needed. A stream is not a turnkey remote-browser UI, and page screenshots do not include native OS dialogs or browser chrome.

Prefer a DorkOS-owned Playwright manager over letting an agent's MCP process own the canonical browser. Reuse the library's automation engine and saved storage state; preserve existing session/room tool access. The official [Playwright MCP server](https://github.com/microsoft/playwright-mcp) is a useful optional facade, but its tools alone do not provide Canvas display, takeover, tab authority or lifecycle. Today's pinned preset also exposes powerful code/network tools, as the source explicitly documents. Offering those remains a separate advanced-access decision.

### 2. Native Electron browser

Create a distinct [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) with isolated browser session storage, no page Node access, and bounded IPC. Electron exposes capture, console events and input; its [Debugger API](https://www.electronjs.org/docs/latest/api/debugger) provides a CDP transport. Human browsing avoids a pixel-stream UI locally.

This is a new browser surface, not a switch on the current iframe. Native view bounds, layering over React panels, resizing, focus, cleanup, permissions and popup handling need work. [sendInputEvent requires the containing window to be focused](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent), so unattended/background control needs a verified alternative. Playwright's [CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) has lower fidelity than its native connection. Electron automation compatibility must be demonstrated, not assumed.

A web or phone viewer would still need streaming from a running desktop. This makes it a weaker common foundation for the launch-critical web app, and creates a dependency on the desktop process being available.

### 3. Existing Chrome

The [Playwright extension](https://github.com/microsoft/playwright.dev/blob/main/mcp/configuration/browser-extension.mdx) can connect to an existing Chrome/Edge tab and use its current sessions. This is materially different from launching another browser with exported cookies. It suits personal-browser workflows, but the person must explicitly choose which browser/tab is exposed.

Do not assume a debugging port can attach to the normal personal profile: [Chrome's remote-debugging changes](https://developer.chrome.com/blog/remote-debugging-port) require a nondefault user-data directory for those switches since Chrome 136. A dedicated debug profile is viable but loses the key benefit of effortless current-profile access. The extension is the stronger form of this option.

Capture/input permissions, disconnects, tab switches, and sharing into a room need explicit behavior. This is a useful later mode, not the recommended default for DorkOS-owned browsing.

## Playwright, CDP and Chrome DevTools MCP

These are overlapping layers, not mutually exclusive product choices. Playwright is the higher-level automation engine. CDP provides Chromium debugging primitives. A visible browser UI and its ownership model are responsibilities DorkOS must add in either case.

The official [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) offers console/network inspection, screenshots, performance traces and Puppeteer-based automation. Consider it for a scoped diagnostic mode, especially performance work. It does not itself solve shared Canvas rendering, and officially supports Chrome/Chrome for Testing rather than promising Electron compatibility. If adopted, pin its version and evaluate its default usage reporting and external performance-data requests against DorkOS's intended local behavior. Avoid two independent controllers fighting over the same tab.

## Separate-agent debate and alignment

The operator explicitly requested an independent agent debate. `/root/browser_debate` independently reviewed the source and official documentation, then challenged the proposed managed-browser direction.

| Challenge                                                                                     | Resolution                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A hidden Playwright page would repeat the current split and violate the same-page requirement | The stream must show the canonical controlled tab; no second iframe rendering of its URL                                                   |
| MCP ownership could reuse mature tools fastest                                                | Reuse the Playwright engine and login state; DorkOS owns context/tab lifecycle and takeover. Optional MCP access must be scoped separately |
| A server browser contradicts the accepted architectural decision                              | Explicitly amend the ADR after selection; address its original objection by making the browser shared and visible                          |
| Streaming degrades native selection, accessibility and input                                  | Treat these as prototype acceptance gates, not claims of parity                                                                            |
| Native Electron gives a better local browsing experience                                      | Keep it second, because the web and phone still need another presentation path                                                             |
| Personal Chrome saves login friction                                                          | Keep it third as an opt-in path with clear personal-tab authority                                                                          |

Both agents aligned on this ranking and the native Playwright manager recommendation. Alignment is an architectural judgment, not proof that the stream UX will meet the quality bar.

## Ownership and prototype gates

The browser runs on the DorkOS host, including when the person uses the phone/tunnel. Its network location and sign-ins must be explained clearly. A context is owned by a person/session; sharing a room view must not silently share account credentials. Browser contexts separate browser state but are not an OS security boundary.

The first prototype should establish:

1. A person and agent change the exact same page state; screenshot and displayed frame agree after a navigation and popup.
2. Reliable selector actions, coordinate click/drag/wheel, typing/key chords, clipboard, IME and phone input. Native dialogs have an explicit supported flow.
3. Immediate human takeover revokes agent control, including queued actions. One writer; multiple explicit viewers.
4. Correctly attributed console errors, failed requests and screenshots across navigation, tabs and reconnects; bounded buffers and visible dropped-data markers.
5. Usable frame latency/bandwidth through the tunnel, multi-viewer scaling and an accessibility plan. Set measured acceptance targets during SPECIFY rather than inventing results here.
6. Install/start/stop/crash recovery on supported server deployments with pinned browser versions and resource limits. No paid model turn is required to prove browser mechanics.
7. Host-enforced authority and artifact access. No public raw CDP endpoint; deny access to privileged DorkOS origins and validate scoped localhost previews. Origin lists alone are not a complete confinement mechanism. Downloads, popups and storage-state access need an explicit policy.

The accepted [ADR 260912-025251](../decisions/260912-025251-browser-driving-rides-the-in-page-shim.md) rejects a second invisible server rendering with different cookies/viewport. Choice 1 addresses that rationale, but still changes the decision. Do not mark the ADR superseded before operator selection and a reviewed replacement decision.

## Long-term fit: profiles, unattended agents and co-browsing

The operator added five requirements: persistent logins across sessions; clean incognito-like browsing with return to the saved profile; independent unattended agent browsers with optional viewing; multiple people/agents sharing and controlling a browser; no Chrome icons in the macOS Dock/app switcher. These are now part of the IDEATE brief. The operator subsequently agreed to the managed Playwright direction; exact execution scopes remain to be specified.

| Requirement                            | Managed Playwright browser                                     | Native Electron browser                                                    | Personal Chrome extension                                                          |
| -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Saved logins/state                     | Persistent user-data profile                                   | Persistent session partition                                               | Existing Chrome profile                                                            |
| Clean mode and return                  | New ephemeral context; saved profile untouched                 | In-memory partition; saved partition untouched                             | Needs additional incognito permissions/workflow; separate browser state            |
| Independent, unattended agent browsers | Strong fit; server owns lifetime independently of viewers      | Possible with offscreen/background work; desktop process remains necessary | Possible while Chrome runs, but weaker app-independent lifecycle and tab isolation |
| Shared browsing/control                | DorkOS must build shared tab access and input arbitration      | DorkOS must build it; remote participants need streaming                   | Additional selected-tab sharing and authority work                                 |
| No separate Chrome app icons           | Headless launch is the intended fit; verify pinned macOS build | Views live under DorkOS, not a separate Chrome app                         | Does not meet a strict no-Chrome-app requirement                                   |

The recommendation remains option 1. It can support all five by design; none of the current DorkOS paths already supplies all five.

**Persistent profiles:** Playwright's [launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) maintains a dedicated user-data directory. Keep profiles owned and named independently of chat sessions, so an agent can reopen its profile after a chat or browser restart. This persists supported site/browser state, not a promise that a website will never expire or revoke a login. Session-only tokens, MFA and site restrictions need explicit reauthentication behavior.

The current MCP preset imports storage state into an isolated context and deliberately never saves agent changes back. Its saved snapshot is useful for bootstrap/migration, but does not meet continuous profile persistence. The CLI login profile is also currently a separate process: profile ownership/locking must prevent it and the manager from opening the same directory concurrently.

**Clean mode:** [browser.newContext](https://playwright.dev/docs/api/class-browser#browser-new-context) gives isolated cookies/cache. Start it without loading the saved login state. Closing it leaves the named persistent profile untouched; switching back opens or selects that profile's running browser. Clean mode means isolated browser state, not anonymity or isolation from the host network. Decide separately whether temporary downloads and diagnostics are kept.

**Independent browsers:** use distinct profile directories for durable agent identities, or ephemeral contexts for temporary work. The manager may need one process per persistent profile; fresh contexts can share a process where appropriate. Persistent profiles cost more memory than tabs. Multiple browser instances cannot open the same user-data directory concurrently. Two agents intentionally using a shared account should attach to one running context rather than launch competing instances against its files.

**Shared control:** separate profile (saved identity), running browser (context/process), tab (page), viewer (optional subscription) and controller (authorized writer). Multiple people can watch a tab; participants take or pass control. Serialize input per tab/action so two actors do not interleave a click/type sequence. Separate tabs can be controlled concurrently but still share that profile's cookies, logout effects and account-side state. True simultaneous independent work belongs in different browsers/contexts. Sharing a signed-in browser gives access to that account's actions; it is not merely sharing a screen.

**Unattended operation:** closing the Browser panel or the entire web client stops its frame subscription, not the managed browser or agent's work. Start streaming on demand. Keep bounded logs and screenshots available without a viewer. Running work still needs the DorkOS host awake and its server running; persisted identity does not imply an interrupted task automatically resumes after a crash.

**macOS presence:** [headless Chrome](https://developer.chrome.com/docs/automation-and-testing/headless) operates without displaying platform windows. This is the intended normal launch mode. Dock/menu hiding has had Chromium-specific implementation changes, so no-icon/no-focus-steal is a concrete prototype check on the pinned shipped executable, including login and crash paths. A headed development/debug launch would not meet this requirement. Viewing the stream should never require switching to headed mode.

Electron also supports [persistent and in-memory session partitions](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options), so profile/clean-mode support is not unique to Playwright. Its disadvantages remain desktop dependence, background-control compatibility and a separate presentation path for web/phone. Personal Chrome becomes a less compelling default under these requirements, though it can remain an optional connection mode.

**Expanded prototype gates:** save an isolated test login, stop/restart and confirm it survives; open clean mode and confirm absence of saved state, then return; run two independent scripted workers with no viewers; attach two viewers and exercise control handoff/takeover; verify no Chrome Dock/app-switcher icon or focus stealing on macOS. A local fake authenticated site proves mechanics without touching the operator's email. Selected real-site compatibility needs later validation and cannot be inferred from the fake-site result.

## Linear findings and Flow handoff

Read through the configured `flow:linear-adapter`, account `dorkos`, team DOR. Snapshot at 2026-10-01T19:05:46Z covered 251 open and 2,343 closed items. Searched open titles/descriptions and closed titles, then read the relevant issues and comments. This is a bounded search, not a claim about archived issues or every historical description.

| Item                                                                                                  | Current state | Relationship                                                                           |
| ----------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| [DOR-213](https://linear.app/dorkspace/issue/DOR-213) — Preview console, network and screenshots      | Done          | Existing shim evidence path                                                            |
| [DOR-2004](https://linear.app/dorkspace/issue/DOR-2004) — Canvas agent seat                           | Done          | Shipped preview driving, recording and runtime parity                                  |
| [DOR-2007](https://linear.app/dorkspace/issue/DOR-2007) — Drive the embedded browser through the shim | Done          | Intentionally limited to instrumented previews                                         |
| [DOR-2009](https://linear.app/dorkspace/issue/DOR-2009) — Same browser seat across runtimes           | Done          | Reuse the common capability surface                                                    |
| [DOR-2155](https://linear.app/dorkspace/issue/DOR-2155) — Signed-in agent browser                     | Done          | Shipped isolated Playwright MCP and login/export flow; comment cites PR #1930          |
| [DOR-2156](https://linear.app/dorkspace/issue/DOR-2156) — Touch ID sign-in broker                     | Backlog       | Credential filling, not visible shared control                                         |
| [DOR-2662](https://linear.app/dorkspace/issue/DOR-2662) — Preview bridge forgery                      | Triage        | Related trust issue; an in-page nonce is not an isolated-world authentication boundary |

No open exact-match issue for the visible full-browser unification was found. Keep this as a separate IDEATE work item in **Canvas and Browser in Rooms**, related to those shipped items, DOR-2662 and Doc Channel DOR-2665; do not inflate Doc Channel with browser-engine replacement. Tracker creation/triage remains part of the pending write batch under the existing read-only constraint.

Next: carry the agreed managed Playwright direction through Flow SPECIFY with a bounded prototype phase, ADR amendment and explicit acceptance gates, then DECOMPOSE. No production implementation was performed in this research pass.
