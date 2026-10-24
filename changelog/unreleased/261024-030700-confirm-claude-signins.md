---
covers:
  - 'fix(runtimes): pause Claude accounts until their login is confirmed'
---

### Security

- Pause a Claude account when its sign-in changes, until the owner confirms it. Add owner-managed exclusions for folders and sign-ins DorkOS must never use. (DOR-3245)

### Note for people upgrading

- Review Claude sign-ins in Settings → Runtimes before running agents. An empty exclusion list keeps accounts paused.
