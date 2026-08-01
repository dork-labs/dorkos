---
covers:
  - 'fix(tasks): a file on disk cannot switch a scheduled task to run without approvals'
---

### Fixed

- A task file on disk can no longer set a scheduled task to run without approvals. If one asks for it, DorkOS quietly turns the task back down to the normal prompts and notes why in the log. Choosing "Full autonomy" yourself, in the cockpit, still works exactly as before — and the install preview now shows the setting a package's task will really get, not the one it asked for.
- Editing a scheduled task no longer widens what it may do. A task set to a mode the edit form does not offer — like plan mode — keeps that mode when you save, and the form shows you what it is instead of quietly switching it to "Allow file edits".
