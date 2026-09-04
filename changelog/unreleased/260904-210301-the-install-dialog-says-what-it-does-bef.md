---
covers:
  - 'fix(client): the workspaces page explains a worktree once, not twice (DOR-1757)'
  - 'fix(client): message search says its limits in one line, not four (DOR-1757)'
  - 'fix(client): the Notifications tab is scannable by its labels (DOR-1757)'
  - 'fix(client): the install dialog says what it does before it says how (DOR-1757)'
  - 'fix(client): address adversarial review — batch 11 no wall of text (DOR-1757)'
---

### Changed

- Message search now says what it covers in one line instead of four bullets. The full
  list is one click away, and it opens itself when a search comes back empty — which is
  when "search matches whole words" is the answer you needed (DOR-1757)
- Settings → Notifications is scannable by its bold labels. Every row's sentence is
  short, the wall of framing above them is gone, and the how-to for getting DorkOS onto
  your phone is tucked into "Get these on your phone" (DOR-1757)
- The install screen leads with one line — "Adds 12 files. Declares no commands." — and
  opens only the parts you have to read: the commands a package runs, the jobs it
  schedules, and anything that clashes. The rest is one click away, with its count on
  the label, so nothing is hidden (DOR-1757)
- The Workspaces page says what a worktree is once instead of twice, and the folder it
  scans no longer runs off the edge of a phone screen (DOR-1757)
