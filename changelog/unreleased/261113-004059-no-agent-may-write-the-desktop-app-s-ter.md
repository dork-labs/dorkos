---
covers:
  - "fix(security): no agent may write the desktop app's Terminal command, on any runtime (DOR-3105)"
  - 'feat(desktop): the Mac app can add dorkos to your Terminal (DOR-3105)'
  - 'fix(desktop): a fresh Terminal command install never replaces a file that appeared after its check (DOR-3105)'
  - 'fix(desktop): the Terminal command copies one line in every shell, and its row stacks on a phone (DOR-3105)'
  - 'fix(desktop): the Terminal command tab asks the app once when it opens, instead of on every redraw (DOR-3105)'
---

### Added

- The Mac app can add the `dorkos` command to your Terminal. Choose **Install** in **Settings › This computer › Terminal command**. It needs no admin password, and it runs `dorkos browser` and `dorkos --version` from the app. If your Terminal can't find it, or finds another `dorkos` first, the same place gives you one line to copy. Agents can't change the command it installs. (DOR-3105)
