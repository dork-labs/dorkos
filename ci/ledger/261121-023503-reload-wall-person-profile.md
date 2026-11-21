---
id: 261121-023503
title: Initialize the reload-wall witness through the person profile path
kind: hygiene
status: proposed
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: [4036]
ratchet-release: []
field-changes: []
---

The reload-wall witness still constructed a bare browser service and used an
agent open to create its profile. Per-agent profile selection correctly refuses
that call. Carry the approved public-Chrome fixture into this branch and reuse
its invented CI identity, real signed profile bindings and person-open-first
setup. After the agent reuses the initialized profile, navigation, reads and
handoff stay on that chat's page session. Cleanup closes every fixture session
without constructing a database; signed profile records remain memory-only.

This is fixture hygiene, with no production authorization change or pipeline
speed claim. The CI-only assertions and loopback-only reload witness remain;
no retry, timeout, runner, required status or quality floor changes. A fake
backend contract test covers initialization, URL selection, chat isolation,
agent reuse, unknown-chat refusal and unshare revocation. Removing the person
open makes that test fail with the original profile_not_allowed refusal.

Native proof remains for macOS CI; no Electron or Chrome runs on the operator's
computer. Revert or repair this fixture if it opens a real profile, bypasses
person initialization, changes refusal behavior or loses chat-scoped custody.

Files covered: apps/desktop/scripts/local-browser-ci/reload-wall.mts,
apps/desktop/scripts/local-browser-ci/reload-wall-profile.ts,
apps/desktop/scripts/local-browser-ci/public-chrome-profile.ts,
apps/desktop/scripts/local-browser-ci/public-chrome.mts and their profile tests.
