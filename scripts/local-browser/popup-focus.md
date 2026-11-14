# Popup activation and handoff focus

Security withdrew its earlier approval after QA found two failures at `2d776c0ed0`.
The policy's Playwright evaluations granted activation without a click. A timer could
then open a popup after Show, or a form could open one before the person took the tab.

**Do not run this proof before the launch cut on Monday at 18:00 CT.** QA owns
that slot. The builder writes and unit-checks it now. No Docker, image build or
headed browser runs happen on this lane before the cut.

The maintained tests are in
`apps/server/src/services/session/local-browser/__tests__/popup-focus-real-chromium.test.ts`.
They are skipped by normal unit runs. Even when armed, they refuse a Mac host,
Linux outside Docker, a missing Xvfb display, a dirty tracked checkout and a reused
output directory before importing the browser service. They check that Chrome is
already installed; no download is permitted.

After the cut, QA runs the tests inside its existing sealed Linux image, using the
exact committed candidate. Reuse the sandbox and isolated home/profile rules in
[chat-memory.md](chat-memory.md). Keep the network disabled, the source read-only,
and mount only a new evidence directory. Never forward personal accounts, profiles,
keys or the host environment. Do not add `--no-sandbox` or disable popup blocking.

Inside the agreed sealed container and headed Xvfb session:

```bash
env DORKOS_BROWSER_POPUP_PROOF=1 DORKOS_BROWSER_POPUP_PROOF_OUTPUT=/evidence/popup-focus pnpm vitest run apps/server/src/services/session/local-browser/__tests__/popup-focus-real-chromium.test.ts
```

The first test runs timers at 650, 850 and 1010 milliseconds after Show, without a
click. It covers `window.open` and direct form submission in the root page and a
cross-site iframe. A separate owned browser window must keep focus. Every timer
must actually fire. The proof records even transient page targets and checks that
no popup payload ran. A final positive control checks that a real person click can
still open a popup in the taken state.

The second test covers both popup paths through `ask_person`, with and without a
preceding agent click. The separate window must keep focus throughout, no popup
may be created, and the agent must lose read access. Its sample window covers the
delayed attempts; it is an explicit negative observation, not a readiness wait.

The third test leaves the tab with its agent. A hostile page loads three documents
on its own. Each tries a detached target link and an iframe `window.open`, without
a click. This catches activation from automatic title reads, even when the detached
link bypasses the page guard. Every load and attempt must run; another window must
keep focus, no transient popup target may appear, and no popup payload may run.
The page guard is advisory; this proof checks Chromium's popup blocking too.

Harness expressions use raw CDP with `userGesture: false`, including focus reads.
A proof must not create the activation it is measuring. Popup creation, policy
writes, iframe updates and denial reports use the production service.

Keep `candidate.json`, `popup-focus.json`, the test exit status, the container log,
and the image digest together. The receipt records the exact source revision and
actual browser version. A skipped, throttled, partial or timed-out case is not a
pass. This proof has not run at the new candidate yet. Security's re-read and the
post-launch QA result are still required before arming. Keep `hold`.

Audit follow-up still owed: distinguish script/timer popup attempts from a
person's click, so automated attempts do not read as the person's actions. This patch preserves the broker's existing denial signal; it does not claim
that separate audit improvement is implemented or ticketed.
