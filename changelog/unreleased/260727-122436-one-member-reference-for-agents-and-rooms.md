---
covers:
  - 'refactor(sidebar): one member reference for agents and rooms (DOR-579)'
---

### Changed

- Groundwork for putting channels and direct messages into sidebar groups, alongside agents. Nothing looks or behaves differently yet — the sidebar still holds agents only. What changed is how DorkOS records it: pinned items, muted items, and each group's members are now saved as `{ kind, … }` entries in `~/.dork/config.json` instead of bare folder paths, and `agentPaths` on a group is now `members`. Your existing groups, pins, and mutes convert automatically the first time you start this version, so there is nothing to redo (DOR-579)
