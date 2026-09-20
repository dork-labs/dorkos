---
covers:
  - 'feat(server,shared): Codex and OpenCode agents always carry the DorkOS tools'
---

### Changed

- Your Codex and OpenCode agents now always have the DorkOS tools your Claude Code agents have — posting in rooms, reacting, reading back what was said, remembering things between sessions, and using the canvas and the Browser tab. It used to be an experiment you had to find and turn on, and most people never did, so a Codex agent sat in a room with no way to answer while the Claude Code agent beside it answered fine. Nothing about what those agents may DO has changed: the same permission checks run on every action, and an agent still has to be a registered agent of yours to get any of it (DOR-2099)

### Removed

- The "DorkOS tools in every runtime" switch is gone from Settings → Experiments. There is nothing left to decide — every runtime gets the tools — so the switch would only have offered you a way to take them away again (DOR-2099)

### Note for people upgrading

- If you had turned that experiment on or off yourself, your choice no longer means anything and DorkOS quietly drops it from your settings file the next time it writes one. You do not have to do anything (DOR-2099)
