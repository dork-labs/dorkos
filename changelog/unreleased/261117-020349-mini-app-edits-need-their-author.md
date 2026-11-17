---
covers:
  - "fix(extensions): a mini app's server edit runs without a card only when DorkOS can tie it to its author (DOR-4528)"
  - 'fix(extensions): every changed file of a mini app is traced by content, and judged again before it runs (DOR-4528)'
  - "fix(extensions): a person's yes trusts exactly the files they approved, and only DorkOS keeps that record (DOR-4528)"
  - 'fix(extensions): a launch that was ever held keeps its later mini app writes held (DOR-4528)'
---

### Changed

- When an agent edits a mini app it built, the new server code now starts by itself only if DorkOS saw that agent's own chat make the change with its file tools. Any other change, such as one made from a command line or while DorkOS was closed, waits for you to approve it.
- Mini apps that agents on Codex or OpenCode edit now wait for your OK before the new server code starts. DorkOS can't yet see who made those edits.
