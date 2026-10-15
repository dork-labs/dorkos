# Relevant panel resources implementation

**Date:** 2026-10-14
**Work item:** DOR-2916 — Relevant panel resource tabs and computer PiP
**Branch:** `codex/computer-panel-resources`
**Pinned base:** `f35d7bb088ed85924bfc47c6758bbdb801eb2a5f`

## Implementation

- Task 1.1: shared computer session, ordered exclusive input, generation fencing, panel/PiP presenters and phone handoff. Root implementation; integration test worker `/root/decompose`.
- Task 2.1: contextual view preferences, concrete document/PTY tabs, one row, overflow/menu, local close vs explicit Stop/Remove/Pin, standalone chrome preserved. Root implementation.
- Task 3.1: unit verification, browser proof and pushed-revision review. Browser adaptations by `/root/browser_tests`; decomposition and interim review by `/root/decompose`. Submission and review evidence belongs in DOR-2916 and the resulting PR.

Configured implementation/review tiers have no model binding; workers use the harness default. Task API is unavailable; `03-tasks.json` remains canonical. No inference was run. The personal app/guest was neither restarted nor controlled.

## Verification

The full client suite passed: 1,502 files and 19,185 tests. After the final control-error refinement, the three computer suites passed with 38 tests. Client typecheck and build passed. Client lint reports zero errors with existing warnings. Copy-length and file-size guards passed.

Browser checks passed for relevant defaults, concrete-resource overflow, touch reach, session canvas synchronization and room canvas author/pin/unread behavior. Desktop and phone computer checks cover transfer, explicit takeover, fitted-frame pointer coordinates, return, stopped/reconnect states, minimization and immediate control release. Computer responses and pixels are intercepted fixtures; checks reject lifecycle requests. Proof uses isolated 684x ports, screenshots and WebM recordings.

## Review

Interim review found six issues: explicit agent relevance, keyboard activation source and Delete focus, missing room pin actions, external concrete-resource reopening, final-shell closure, and observing subscribers cancelling another owner's pending takeover. All were addressed and regression coverage expanded. A fresh independent reviewer checks the pushed revision before the PR opens; its findings and convergence are recorded with the revision in the tracker and PR.

## Assumptions and limits

The server supports one experimental local computer. Confirmed cwd binds its view to the agent. PiP keeps that binding and generation. Transferring returns control and requires explicit takeover. Browser proof uses fixture pixels/leases and covers UI behavior; it does not replace the MVP owner's real guest/model proof. Paid inference authority from the MVP session is not used here. Managed Browser and Community programmes remain human-paused.

## Broader system review

The human requested a broader mobile-browser, mini-app and system review. It found and addressed resource/mini-app identity collisions, final-view reload behavior, mobile full-page navigation hidden by the panel, hidden-terminal error containment, small touch targets, keyboard/panning geometry and PiP peek content clipped below the screen. Deferred input/release failures are fenced so they cannot affect a newer takeover.

The expanded focused run passed 244 tests in 18 files. WebKit passed 17 browser checks across computer handoff/rotation, mini-app placement/close/reopen/unload/full-page navigation, PiP dock/keyboard/long-content scrolling, tab overflow and touch/browser-address reach. Chromium passed the same 17 browser checks. Final required verification and pushed-revision convergence review are recorded with submission evidence in the PR and tracker. Browser keyboard proof simulates visual viewport events; it does not claim an attended test of a physical iPhone keyboard.

## Terminal lifecycle review

Closing a shell view is owned by the terminal model, so pending client identities cannot reopen when a PTY UUID arrives. Hidden PTYs retain their view state across remount and reload. A scoped new-shell request reaches an owner that has not mounted yet and creates a fresh shell alongside restored ones. Optimistic header selection remains visible until the owner publishes the new or reopened view. Stop remains a separate destructive action.

Real isolated-shell browser regressions verify delayed startup, close/reopen without creating another shell, and adding a new shell alongside saved PTYs. The independent review also covers replacing the owner before a hidden pending shell resolves; late identities must be adopted by the replacement owner without overwriting its active selection.

The final terminal-focused run passed 191 tests in 14 files. Four desktop/phone browser checks passed against isolated real PTYs, with no shell commands or agent turns. Their saved UUID assertions cover process ownership as well as header appearance.

## Merge queue compatibility

The combined queue candidate exposed stale resource selectors in room-follow tests and a Connections assertion that also counted the inspector's tabs. The page objects now follow the concrete resource IDs and scope Connections assertions to its routed content. The room-follow fixture preserves complete real membership data and resolves its response before interception, preventing a teardown race. Both original failures were reproduced; the full affected browser files then passed all 13 checks, including phone Follow behavior.

The panel's initial page URL uses the canonical shared links module. The small pure helper and its tests are byte-identical to the merged company-links change at `e55eb0b06864ff751a19542abe9cb4f5bde31803`, so this branch also builds independently. The focused panel, links and company tests passed 19 tests across three files. The first full rerun hit the server TypeScript process's V8 heap limit; final verification must run against the final source tree with sufficient heap and record its actual result.

## Document identity and local choices

The final audit reproduced two local-view regressions: closing an optimistic document did not carry its closure onto the server ID, and assigning a canonical conversation ID lost the document's scoped closure. The bounded preference map now shares the document's client store; identity settlement and conversation handoff transfer closures in the same transaction. Document choices use the captured owner conversation/directory, separately from ambient agent view choices. Existing stored closures still restore and explicit reopening removes their exact owner keys.

A server event or snapshot can arrive before the open request response identifies its document. Possible echoes of a closed pending open are deferred temporarily in the shared header, preserving existing identical documents. The response resolves the actual identity, releases ambiguous concurrent rows, and honors an explicit newer reopen or later close. Content matching never establishes a durable identity or deletes a server row.

The focused causal and storage run passed 119 tests in five files. The final broader panel/store and shared links/company run passed 360 tests in 21 files. The settings-reset regression was separately reproduced red, then all six reset tests passed: resetting all settings clears local view choices while appearance reset preserves them.

Independent review reproduced three further edge cases: a captured null directory resolving, a possible echo changing content before the response, and a pinned echo being dropped from a premature candidate limit. All three independent real-hook regressions now pass. Explicit owner binding migrates unresolved directory choices; temporary candidates retain observed IDs through updates and are pruned against the final retained table, including pinned/protected rows. Reopening and closing again never selects an unresolved duplicate automatically.

Six desktop/phone browser tests passed on the final receipt-cleanup source. The event-first cases hold the real open response, receive its socket event, update that UUID through the actual API, and confirm the newer revision remains hidden until + reopens the same document. Releasing the stale response preserves newer content; no extra document is created or deleted by closing/reopening its view. The temporary test source and screenshots are preserved outside the worktree, and isolated test resources are cleaned up.

Late save responses retain their captured document owner after the reader switches conversations. Canonical handoff and explicit directory resolution also migrate outstanding receipts and local choices while that owner is offscreen. A newer explicit selection of the actual server UUID survives departure, and a later close still wins. Settlement changes only the original owner’s preferences when its document table is no longer visible.

Receipt cleanup belongs to the exact request, including completion, refusal, held cancellation and timeout. Retrying a held request transfers that ownership without premature cleanup; another write sharing the same pending document cannot discard it. Independent real-hook review reproduced the navigation and overlapping-write failures before the fix; all five selected causal cases then passed. The two additional desktop/phone checks use saved scripted conversations and real SPA navigation, with no model calls. They passed again alongside the four HTTP/event/update checks on the final cleanup source.

The broad verification run completed the type/lint phase and the client suite (1,503 files, 19,215 tests), then ended with exit 143 during server tests. That run is incomplete, and its termination cause is unconfirmed. A separate native dependency incident was later narrowed to another checkout; this worktree’s independent native copies were checked by hash, inode and an actual Node ABI load without a rebuild. Final verification runs again on the corrected tree.

## Source structure and enforced size limit

The actual max-lines ratchet caught growth that warning-level lint did not block: the canvas store’s 959 significant lines exceeded its existing 739-line baseline. Document receipt/view ownership, candidate matching and pure document conversion now live in three focused shared-model modules. Their type-only backlinks avoid runtime import cycles, and conversion/fingerprint definitions remain single implementations. The main canvas store now has 709 significant lines; the normal baseline update lowered only its entry from 739 to 709. The merge-base max-lines guard passed without raising any limit.

After extraction, all 119 focused causal tests, the broader 360 tests in 21 files, client typecheck, scoped lint and formatting passed. All six desktop/phone HTTP, event/update and saved-conversation navigation checks passed again on the extracted source, with temporary resources cleaned up. Copy-length and vocabulary guards passed. The independent five actual-hook reproductions passed again, with no public API, transaction or resource-lifetime change found. A live-output broad verification was explicitly canceled for this required extraction and is recorded as incomplete. Two earlier quiet runs ended with unexplained exit 143; their partial results remain separate from final verification.
