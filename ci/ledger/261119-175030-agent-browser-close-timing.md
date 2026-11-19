---
id: 261119-175030
title: Record agent browser close timing without changing its deadline
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.desktop-smoke.packaged-runtime
prs:
  - 3992
ratchet-release: []
field-changes: []
---

The public Chrome proof timed out while closing a fresh agent context for its
second handoff. The earlier sign-in window had already quit and saved its cookie;
its 1039 ms exit time does not measure the failing agent-context close.

Record each agent window's close request, context-close event, close-promise
settlement and profile lock state in `agent-close-timing.ndjson`. If the promise
is still pending at the existing 2000 ms response boundary, record that state too.
Use a monotonic elapsed time and wall-clock timestamps. Append synchronously so
the evidence survives a failed handoff or a child that cannot finish cleanup.
Only the CI script measures this; no product logging or teardown behavior changes.

This is observability hygiene, with no speed or reliability claim. No deadline,
retry, required check, verdict, runner or shard changes. Read the evidence from
2–3 Desktop Smoke runs before choosing a teardown fix. Revert if measurement
changes the close result, delays a handoff materially or records page contents.

Files covered: apps/desktop/scripts/local-browser-ci/public-chrome.mts.
