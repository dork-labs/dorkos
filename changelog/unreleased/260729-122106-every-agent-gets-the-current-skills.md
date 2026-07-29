---
covers:
  - 'fix(agents): give every agent the current skill pack on boot'
---

### Fixed

- Your agents now keep up with the built-in DorkOS skills. Until now only DorkBot did, and every other agent kept the skills it was handed on the day you made it. That matters when we correct a skill. One correction taught agents to warn you before deleting a task, and agents made before that fix never found out. Now DorkOS refreshes the built-in skills every time it starts, and puts them where the agent can actually read them (DOR-671)
- Your own work survives the refresh. A skill you wrote is left alone, and so is a built-in skill you have edited. Deleting a built-in skill does not stick, though: it comes back the next time DorkOS starts, so edit it instead if you want it out of the way. Agents you registered from a folder of your own are not touched at all.
