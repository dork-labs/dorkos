---
covers:
  - 'feat(extensions): let an extension message an agent with ctx.agent.send (DOR-2683)'
  - "fix(session): disarm swept rows' pending entries whether or not anyone listens (DOR-2683)"
  - 'fix(extensions): tighten ctx.agent.send targets, ids, races and stops after review (DOR-2683)'
---

### Added

- Let an extension send one of your agents a message. A busy agent holds it until its current turn ends, and the extension hears when the agent starts on it, finishes, or will never get to it (DOR-2683)
