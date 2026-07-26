---
covers:
  - 'fix(security): agents cannot route around the approval gate (DOR-467)'
---

### Security

- Uninstalling a package now asks you first, whichever way an agent reaches for it. The
  `dorkos uninstall` command used to remove packages with no approval at all, and it was the
  command your agents were taught to use. Now an agent gets an approval card and waits for
  your answer, and you can hand it the go-ahead with `dorkos uninstall <name> --approval <token>`.
  Clicking Uninstall yourself in DorkOS works exactly as before (DOR-467).
- Agents can no longer change the settings that protect your instance through the settings
  API. Turning off sign-in, widening which folders DorkOS may touch, and changing where its
  credentials go are yours to choose. Your own changes in Settings are unaffected (DOR-467).
