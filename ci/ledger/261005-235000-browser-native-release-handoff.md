---
id: 261005-235000
title: Bind the Mac browser observer to the Linux-built CLI
kind: hygiene
status: reverted
actor: agent
gates:
  - wf.browser-native-release-artifact.build-darwin
  - wf.browser-native-release-artifact.verify-linux-handoff
prs: []
ratchet-release: []
field-changes: []
---

A Linux CLI build cannot compile the Darwin observer. Add an explicit release-artifact producer on the same source commit, then exercise the Linux consumer using the producer job's exact manifest hash. The Mac job captures its actual CLI, both workers, C/H, observer binary and native manifest. The consumer requires unchanged original sources, matching freshly bundled workers, original producer controller/worker/observer provenance, bounded closed original reads and a pinned manifest. Its final package manifest binds the imported observer to its own actual CLI bytes. No supplied executable is run by the handoff. The existing explicit publish:cli command now obtains and verifies the same-tag original producer automatically before normal pnpm publication; release:cli:prepare uses the same path to build and pack without publishing. Original dispatch entry is retained in the Git common directory if Actions has not yet exposed its run ID, so a process retry cannot silently issue another producer. Source enumeration counts files and directories, limits depth, closes original directory handles and uses deterministic codepoint ordering. Before original dispatch/download/build or publication/packing, freshly resolved trusted default-main metadata and an exact original GitHub comparison must prove the release HEAD is on main; local tag equality supplies no merge proof. Six controls refuse unmerged and changed remote ancestry.

This is functional release packaging hygiene. It adds no required PR or merge-queue checks and changes no existing gate, retry or timeout. The new manually dispatched producer and consumer have an initial 56-minute ceiling borrowed from the existing Desktop Release Mac producer, with no new duration measurement claimed. Native acceptance, sustained observation and readiness remain separate and unverified until genuine runtime controls run. Revert if a changed source or worker can be accepted or if the cross-host artifact build fails its provenance controls.

Retirement recorded by 261009-021811-retire-obsolete-darwin-handoff: this historical merged entry is retained verbatim above apart from lifecycle status. The old manual observer handoff is superseded by the closed VM packaging graph. Its two non-required census jobs are removed; no publisher-signed VM assets are asserted or enabled.
