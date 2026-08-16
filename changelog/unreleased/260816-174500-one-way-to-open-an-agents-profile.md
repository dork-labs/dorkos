---
covers:
  - 'refactor(client): delete the Agent Hub feature, now that the Profile has replaced it'
  - 'refactor(client): one verb for the profile — View profile, everywhere'
  - 'fix(client): the Team table opens the profile the way the cards do, plus the push-in e2e (DOR-1255)'
---

### Changed

- Everywhere you could open an agent now says the same thing: **View profile**. The sidebar's "Agent hub", the Team table's "Manage", the status line's right-click menu, the command palette and the topology map all used a different word for the same act, and they all landed somewhere slightly different. One word now, and one place — the profile, which docks beside your session or slides in from the side depending on where you are (DOR-1255)
- Links you saved to the old Agent Hub still work. They open the profile (DOR-1255)
- On the Team page, **View profile** in the table now opens the same profile card the cards open, instead of a different panel off to the side (DOR-1255)
