---
covers:
  - 'fix(agents): project seeded agent skills so Claude Code can read them (DOR-659)'
---

### Fixed

- Every agent ships with a small set of built-in skills that teach it how to run DorkOS. Those skills were being written to a place the default runtime does not look, so agents never actually learned them. They now land where the agent can read them, for new agents and for DorkBot (DOR-659).
- Agents that DorkOS set up for you are repaired the next time you start it. Nothing to click, and it does not slow startup down. Agents that live in your own project folders are left alone, because starting DorkOS is not a reason to write files into your projects (DOR-659).
- DorkBot re-checks its own skills on every start, so if the links are ever lost it puts them back on its own (DOR-659).
