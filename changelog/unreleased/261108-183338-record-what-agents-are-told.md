---
covers:
  - 'feat(server): record what each turn actually handed its runtime (context viewer phase 1)'
---

### Added

- DorkOS now keeps a private record of exactly what each agent was told on every turn: the instructions it started with and the notes added to that turn. This is the groundwork for a future screen where you can see what your agents are told. Nothing shows it yet. The saved text stays on your computer, is never sent anywhere, and is deleted with its chat or after 30 days, whichever comes first. Passwords and keys are removed before anything is saved.
