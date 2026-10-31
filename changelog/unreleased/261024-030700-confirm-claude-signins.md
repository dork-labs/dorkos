---
covers:
  - 'fix(runtimes): preserve existing logins and require confirmed handoff targets'
  - 'fix(runtimes): refresh confirmed sign-ins through the shared config query'
  - 'fix(runtimes): keep excluded account aliases out of probes'
  - 'fix(runtimes): pause Claude accounts until their login is confirmed'
---

### Security

- Pause a Claude account when its sign-in changes, until the owner confirms it. Add owner-managed exclusions for folders and sign-ins DorkOS must never use. (DOR-3245)

### Note for people upgrading

- Existing Claude sign-ins stay confirmed after upgrading. Changed logins wait for confirmation in Settings → Runtimes. Without an owner password, confirm on the Mac running DorkOS.
