---
id: 261116-043455
title: Desktop smoke records the browser chrome's tooltip frames
kind: hygiene
status: proposed
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: [3830]
ratchet-release: []
field-changes: []
---

Why: design asked for proof, on a real native page, that the Agent browser's chrome tooltips wait 500ms and never blank the page (DOR-4427). That can't be shown in jsdom, and the desktop app must not run on the operator's Mac (Keychain risk).

What: the existing CI-only native witness (`smoke-local-browser.ts`, already run by `wf.desktop-smoke.packaged-runtime` on its macOS runner) gains one more Electron run, `local-browser-ci/chrome-tooltips.ts`. It moves a real pointer onto Back and asserts three things: no tooltip inside the delay, the page hides only once its still is drawn, and with no still the page never hides and Back keeps its `title` hint. It saves window pictures to `apps/desktop/browser-proof-artifacts/chrome-tooltips/`, which the job's existing upload step already publishes. No workflow file changes: no new job, trigger, secret or permission. A picture that can't be taken only warns, so the asserts remain the check.

Cost: one more Electron launch in a job measured at about 6 minutes, bounded by a 120 s run timeout.

Revert if: the witness flakes on the runner (pointer events or window capture), or the job's median time grows by more than a minute.
