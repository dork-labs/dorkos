---
covers:
  - 'feat(marketplace): checks disclose, no unbound apply, and global plugins load only what a person approved (DOR-2306)'
  - 'feat(marketplace): bind the HTTP update apply to what a person was shown, and ask before a global plugin runs (DOR-2306)'
  - 'feat(client): show what each update runs before you confirm it (DOR-2306)'
---

### Security

- Before you update a package, DorkOS now shows what the new version runs on its own: each command and when it runs, and each server or program and whether it starts in every session. Updating installs exactly what you saw. If the package changes what it runs in the meantime, nothing is updated and DorkOS asks you to look again (DOR-2306)
- An agent can no longer update a package behind your back. When an agent asks, you get an approval card listing everything the new version runs, and nothing changes until you allow it (DOR-2306)
- A package installed for everyone loads into every session, so one that runs commands or programs of its own now loads only after you approve exactly what it runs. Installing or updating it yourself counts. If it changes any other way, DorkOS holds it back and asks you. After this update, you may see one card for each such package you already have (DOR-2306)

### Changed

- `dorkos update --apply` now prints what each new version runs and asks before it installs. Add `--yes` to skip the question. `dorkos update <name>` without `--apply` still only checks (DOR-2306)
