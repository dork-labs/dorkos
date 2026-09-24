---
covers:
  - 'feat(marketplace): checks disclose, no unbound apply, and global plugins load only what a person approved (DOR-2306)'
  - 'feat(marketplace): bind the HTTP update apply to what a person was shown, and ask before a global plugin runs (DOR-2306)'
  - 'fix(marketplace): bind global plugin approval to its bytes, ask before an agent replaces one, re-check every turn, and show what is held back (DOR-2306)'
  - 'feat(client): show what each update runs before you confirm it (DOR-2306)'
  - 'feat(client): fold unchanged runs, wrap commands between their parts, and let Review sit beside a held-back note (DOR-2306)'
---

### Security

- Before you update a package, DorkOS shows what the new version runs on its own: each command and when it runs, and each server or program and whether it starts in every session. What is new since the version you have comes first. The update installs only that version, with those files. If the package changes before the install, nothing is updated and DorkOS asks you to look again (DOR-2306)
- When an agent asks to update a package, or to install one for all your projects that runs commands or replaces one you have, you get an approval card first. It lists what the package runs, its version, where it comes from and which agent asked. Nothing changes until you allow it (DOR-2306)
- A package installed for all your projects loads into every session. If it runs commands or programs of its own, it now loads only after you approve it exactly as it is, down to its files. Installing or updating it yourself counts. If its files change any other way, DorkOS holds it back from the next message on and asks you. After this update, expect one card for each such package you already have (DOR-2306)
- A package that is held back says so on its row in **Installed**, with a **Review** button. `dorkos marketplace held-back` lists them in the terminal and lets you allow or turn one down, and `dorkos` lists them when it starts (DOR-2306)

### Changed

- `dorkos update --apply` prints what each new version runs and asks before it installs. Add `--yes` to skip the question. `dorkos update <name>` without `--apply` still only checks. An older `dorkos` CLI is told to update itself instead of updating anything (DOR-2306)
