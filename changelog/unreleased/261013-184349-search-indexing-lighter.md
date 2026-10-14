---
covers:
  - 'perf(server): index search in pieces and skip subagent folders (DOR-2904)'
---

### Fixed

- Building the message search index is lighter on DorkOS. It no longer lists the thousands of helper-agent transcripts it never indexes, and it saves a very long chat to the index a piece at a time instead of all at once. If DorkOS stops partway through a long chat, it carries on from where it got to (DOR-2904)
