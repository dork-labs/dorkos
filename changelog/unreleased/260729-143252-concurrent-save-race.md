---
covers:
  - 'fix(server): stop concurrent saves losing data or landing under the wrong write'
---

### Fixed

- Saving from two places at once no longer loses one of the saves (DOR-697). If you had DorkOS open in two tabs, or an extension saved in the background while you changed a setting, two saves to the same file could collide: one would fail with an unexplained error, and the other could quietly store the wrong content. Sign-in details for your agent runtimes, your marketplace sources, and your agent templates were all stored this way — a collision could drop a saved key or source, and in the worst case wipe your whole template list. Saves to the same file now take turns, and each one keeps its own content.
