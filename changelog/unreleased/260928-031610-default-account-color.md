---
covers:
  - "feat(server): let this computer's own Claude sign-in have a color of its own (DOR-2492)"
  - "fix(server): let the server alone decide the default account's color (DOR-2492)"
  - "fix(server): keep the implicit default's contract color null (DOR-2492)"
---

### Added

- You can now set the color of this computer's own Claude sign-in with `runtimes.claudeCode.defaultAccountColor` in your config file. That is the account DorkOS calls "Main" when you haven't added its folder as an account, and until now it always showed the default color for its place in the list. Only you can change it, not your agents. If you have added that folder as an account, the account's own color is still the one used (DOR-2492).
