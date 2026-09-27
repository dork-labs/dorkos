---
covers:
  - 'feat(accounts): find unregistered Claude account folders and let Settings dismiss them (server)'
  - 'feat(settings): offer the Claude account folders found on this computer (DOR-2387)'
  - "fix(settings): let a found folder's buttons wrap under its name on a phone"
---

### Added

- Settings → Runtimes → Claude accounts now lists other Claude account folders it finds on your computer, like `~/.claude2`, under "Found on this computer". Nothing is added until you click Add. Dismiss hides a folder for good. A folder that looks company-managed is marked "managed by an organization", so you can decide whether to add it (DOR-2387)
