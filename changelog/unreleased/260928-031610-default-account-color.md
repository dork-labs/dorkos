---
covers:
  - "feat(server): let this computer's own Claude sign-in have a color of its own (DOR-2492)"
---

### Added

- You can now pick a color for this computer's own Claude sign-in, the account DorkOS calls "Main" when you haven't added its folder as an account. Until now it always showed the default color for its place in the list. The setting is `runtimes.claudeCode.defaultAccountColor`, and only you can change it, not your agents. If you have added that folder as an account, the account's own color is still the one used (DOR-2492).
