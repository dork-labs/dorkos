---
covers:
  - "feat(runtimes): a Codex agent's heavy job counts in the line while it runs, and its next reply waits on a busy computer (DOR-4743)"
  - 'fix(runtimes): review fixes for Codex commands in the load gate (DOR-4743)'
---

### Added

- Heavy jobs from Codex agents now take their place in the shared line. This includes jobs Codex runs without asking you first, which is every job on Full access. DorkOS only hears about such a job once it is already running, so it can't hold it back. Instead, the job takes a turn while it runs, and other agents' heavy jobs wait behind it. When the computer is busy and Codex jobs are running, a Codex chat's next reply waits to start, and the chat tells you so. It waits no longer than the longest wait in your load gate settings (60 minutes unless you changed it), then starts anyway. Press Stop to end the wait before Codex sees your message. A Codex job can still start on a busy computer if its reply began while the computer was calm. (DOR-4743)
