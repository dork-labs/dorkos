# Local Playwright browser tasks

Canonical source: `03-tasks.json`. All tasks are pending; feasibility is not yet proven.

### Task 1.1: [local-playwright-browser] [P1] Prove exact embedded Playwright control

Build an isolated Electron 41 WebContentsView fixture using pinned playwright-core 1.63.0 and local HTTP pages. Implement the candidate page-only debugger transport, then use real Playwright navigation, snapshot, locator click and fill against the visible native view. Prove human keyboard/mouse input remains usable, a second page and shell are unreachable, stale references are rejected and teardown releases owned resources. No synthetic shim clicks, duplicate browser, exposed application evaluation or inference. Record resolved versions and evidence; block dependent embedded implementation if this does not pass.

Dependencies: none. Phase: Foundation.

### Task 1.2: [local-playwright-browser] [P1] Verify pinned usual-browser attachment

Inspect installed Playwright 1.63.0 source/types and the matching documented browser channel or extension attachment flow. Build a local fixture using isolated Chrome/Edge data, exercise browser permission, select one tab and verify real sign-ins/extensions remain in that browser. Record supported versions, setup requirements, disconnect behavior and unsupported errors. Prove detach leaves personal-style tabs open and never copies data or restarts a personal browser. A newer upstream example alone is not proof.

Dependencies: none. Phase: Foundation.

### Task 1.3: [local-playwright-browser] [P1] Define local browser ownership and action contracts

Add versioned Zod contracts and a narrow engine port for embedded/window/existing modes, capabilities, explicit session/page identities, readable status/title/URL, pause flag, generation/observation revision and safe errors. Use existing shared Transport and authenticated Hono request chain with readJsonBody and honoRequestFacts. Keep this registry separate from old VM/streaming custody. Agent commands must reject foreign IDs and stale generation. Tests prove cross-session denial, unsupported defaults and strict argument validation. Record panel/PiP and runtime owner agreements.

Dependencies: 1.1, 1.2. Phase: Foundation.

### Task 2.1: [local-playwright-browser] [P2] Ship persistent separate browser windows

Implement headed Playwright persistent Chromium using the exact executable revision supported by 1.63.0 and a reserved DorkOS-owned data directory. Include library in CLI/desktop runtime dependencies and manage automatic executable acquisition with bounded progress, cancellation, retry, revision validation and cache reuse. Never require manual Playwright install, npx or personal data copying. Preserve saved site data across restart and upgrade; reject concurrent directory writers. Test local cookie continuity, missing executable, bad revision, download refusal, insufficient disk and owned cleanup.

Dependencies: 1.3. Phase: Modes.

### Task 2.2: [local-playwright-browser] [P2] Host the embedded desktop browser

Implement sandboxed WebContentsView ownership in desktop main with a dedicated persistent partition, no Node integration or shell preload, and the proven page-only transport. Register only owned frames/workers; deny shell/root/browser target access. Connect bounds/visibility/focus to the panel owner contract, including resize, collapse, route changes, dialogs and window close. Register or clearly reject popup pages. Preserve same page identity during supported presentation moves; never duplicate or stream as PiP fallback. Native fixtures verify visible action effects, manual input, target denial and release on close.

Dependencies: 1.1, 1.3. Phase: Modes.

### Task 2.3: [local-playwright-browser] [P2] Connect a chosen usual browser tab

Implement the verified Playwright 1.63.0 Chrome/Edge channel or permission-extension attachment flow. Guide browser permission and explicit tab selection; give runtime tools only the selected page, with new popup/tab registration explicit. Invalidate observations on tab change, navigation, close and reconnect. Disconnect must detach without closing tabs, deleting data or quitting the browser. Unsupported browser/version, denied permission and closed browser return recoverable states. Real fixture proves selected-tab isolation, no personal data copying, reconnect identity and continued extensions/sign-ins in browser.

Dependencies: 1.2, 1.3. Phase: Modes.

### Task 3.1: [local-playwright-browser] [P3] Expose scoped live-page tools and Pause

Add validated runtime tools for bounded page selection, navigation, snapshot/screenshot, click/fill/key/scroll and observation without arbitrary evaluation, Playwright code, shell, raw network or debugger commands. Coordinate runtime owner and remove old npx/headless copied-state binding for new mode selection. Serialize agent mutations while native human input stays live. Pause rejects new/queued mutations; dispatched effects return known or unknown results without replay. Check observation revision/element binding immediately before input and stop stale auto-wait from acting in a new document. Test timeout after form submission, human navigation, transport loss, pause race and resume requiring fresh observation. Audit excludes filled values/secrets.

Dependencies: 2.1, 2.2, 2.3. Phase: Product.

### Task 3.2: [local-playwright-browser] [P3] Present three plain-language browser choices

Implement exactly DorkOS browser, New browser window and Your existing browser through the agreed resource-tab/right-panel contract. Embedded is desktop default where supported; New browser window is local npm default, and embedded choice explains Requires the DorkOS desktop app. Show readable chosen browser/tab/title/URL and agent. Provide permission, connect/disconnect/reconnect, Preparing browser, Pause agent/Resume agent, Browser closed, Page changed and Action result unknown recovery. Every app block is at most 15 words with no profile/CDP/provider jargon. Keep keyboard/focus/screen reader behavior and responsive controls. No iframe duplicate or competing tab registry. Browser tests prove labels, defaults, recovery and Pause.

Dependencies: 1.3, 2.1, 2.2, 2.3. Phase: Product.

### Task 4.1: [local-playwright-browser] [P4] Prove installed CLI and desktop behavior

Pack CLI tarball and isolated desktop artifact; record hashes and resolved Playwright/Electron/browser revisions. Install CLI into clean isolated data/work directory without repository node_modules or npx. Prove included library, automatic first executable acquisition and offline cache reuse, visible persistent separate window, usual-browser consent and selected-tab operation. Run packaged desktop exact-WebContentsView fixture plus external modes with separate app-data directory. Exercise human input, saved-logins restart, pause/navigation/unknown-effect and cleanup ownership. No inference or changes to personal installed DorkOS0.114.1/browser data. Document actual platform coverage and keep untested claims gated.

Dependencies: 3.1, 3.2. Phase: Delivery.

### Task 4.2: [local-playwright-browser] [P4] Document and independently verify delivery

Update browser docs and obsolete signed-in-browser/CLI help around three choices, included library versus browser preparation, platform limits, saved logins, permission, disconnect, Pause and unknown-action recovery. Remove superseded competing paths while preserving applicable preview shim behavior. Root maintains spec/ADR manifests and tracker evidence. Run targeted meaningful typecheck/lint/tests and required pnpm verify; complete independent review, normal commit/push hooks and protected merge. Record proof limits honestly, resolve review findings, and clean only creator-owned resources after completion. All three modes and installed-package proof remain completion requirements.

Dependencies: 4.1. Phase: Delivery.

Critical path: exact embedded proof and attachment proof → contracts → all three modes → tools/presentation → installed proof → independent verification and protected merge. Mode work can proceed in parallel after ownership and contracts are agreed.
