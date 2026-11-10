---
covers:
  - 'feat(server): record what each turn actually handed its runtime (context viewer phase 1)'
  - "fix(server): close Security's four Musts on the turn-context record"
---

### Added

- DorkOS now keeps a private record of exactly what each agent was told on every turn: the instructions it started with and the notes added to that turn. This is the groundwork for a future screen where you can see what your agents are told. Nothing shows it yet. The saved text stays on your computer and is never sent anywhere. It is deleted with its chat or after 30 days, whichever comes first, though DorkOS's own database backups on your computer can keep a copy until those backups are replaced. Known kinds of passwords and keys are removed before anything is saved.
