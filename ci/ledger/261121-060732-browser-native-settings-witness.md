---
id: 261121-060732
title: Keep native browser settings in the sealed witness
kind: hygiene
status: active
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: [4038]
ratchet-release: []
field-changes: []
---

The sealed reload-wall witness now checks that an unsolicited popup is blocked and a clicked-link popup opens, and records the operating system media preferences. It keeps the person-first profile initialization and in-memory signed binding store from #4037, and the clean hand-off from #4036. No workflow, required gate, retry, timeout or quality floor changes.

The launch options restore Chrome's normal popup blocking and color management and stop emulating display/accessibility preferences. Unit tests cover installed Chrome and managed Chromium while pinning the retained automation and security settings. The native witness still uses invented loopback pages and a throwaway profile in CI only; it is not run on the host Mac. Revert the witness extension if its popup assertions do not distinguish blocked unsolicited opens from permitted clicked links.
