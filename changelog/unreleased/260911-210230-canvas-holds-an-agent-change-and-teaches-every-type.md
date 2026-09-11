---
covers:
  - 'fix(runtimes): teach every canvas type and UI action from one catalog'
  - "fix(canvas): offer an agent's change instead of dropping it mid-edit"
  - 'fix(canvas): clear a held change once a newer one lands'
  - 'Merge origin/main (Claude Agent SDK 0.3.268) into DOR-1996'
---

### Fixed

- When an agent changes a document while you are editing it, the canvas now tells you and lets you pick. Your edit was always protected, but the agent's version used to be thrown away without either of you being told. You get a quiet notice with two buttons: Reload shows their version and ends your edit, and Keep mine throws theirs away. Your agent is still told the change went through — it has no way to know you were typing — so for now the notice is only on your side.
- Agents now know about everything they can put on the canvas. What they were told listed 6 of the 14 kinds, so files, side-by-side changes, web pages, 3D models, sound, video and CSV tables were all things an agent could open and had never heard of. The command that applies a saved layout was missing too, and could not be run at all.
