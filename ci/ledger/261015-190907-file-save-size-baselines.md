---
id: 261015-190907
title: Lower file-save module size baselines
kind: hygiene
status: active
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

Record the normal file-size baseline reductions after extracting file-save receipt code: system-methods 598 to 548, document store 552 to 549, shared Transport 1109 to 1108, and app-store canvas 709 to 694. Keep every other Main baseline. The scanner, file limit, test exemptions, required checks, retries and test timeouts retain their existing behavior. This is bookkeeping hygiene with no performance claim or ratchet release. Stop publication if normal counters differ from the reviewed source; investigate the extraction rather than raising a baseline.
