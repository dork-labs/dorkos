---
covers:
  - 'fix(agents): agent text and the instructions viewer use plain names, and the built-in runtime shows as DorkOS (DOR-4114)'
---

### Changed

- Agents are no longer told internal names like "Relay" and "Mesh", so they stop repeating them to you. They now say "chat connections" and "the agent directory". (DOR-4114)
- The instructions viewer says "the persona file" and "the boundaries file" instead of file names, and shows the built-in runtime as "DorkOS". The agent list's "Runs on" filter calls it "DorkOS (built-in)". (DOR-4114)
