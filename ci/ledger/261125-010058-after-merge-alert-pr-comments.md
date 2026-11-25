---
id: 261125-010058
title: after-merge-alert can comment on the merged pull request again
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.after-merge-alert.alert
prs: []
ratchet-release: []
field-changes: []
---

Since #4191 the alert job held only `issues: write`. Commenting on a pull request number answered
403 "Resource not accessible by integration", so the job failed and the author never heard
(runs 45514252705, 45519906880 and 45521131678 on Nov 24, for #4331, #4333 and #4315). It now
also has `pull-requests: write`. The job runs main's copy only (workflow_run on a push to main).
Target: no 403 in after-merge-alert runs from the next week. Revert if it needs less than this.
