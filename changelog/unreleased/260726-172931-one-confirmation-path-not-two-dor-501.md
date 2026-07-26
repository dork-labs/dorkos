---
covers:
  - 'refactor(marketplace): one confirmation path, not two (DOR-501)'
---

### Removed

- Installing a marketplace package always waits for you to say yes, and there is no longer a way to switch that off. A setting called `MARKETPLACE_AUTO_APPROVE` used to skip the question for scripts and CI runs. It is gone. If you install packages from a script, have the script answer the request the way the app does: read `GET /api/approvals/pending`, then `POST /api/approvals/:id/grant`, and retry the install. If you have Require login turned on, that script needs a per-user API key (from the Security tab in Settings) to make those calls at all. There is a full walkthrough in `contributing/external-agent-marketplace-access.md`.
