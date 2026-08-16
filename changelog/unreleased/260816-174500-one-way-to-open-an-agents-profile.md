---
covers:
  - 'refactor(client): delete the Agent Hub feature, now that the Profile has replaced it'
  - 'refactor(client): one verb for the profile — View profile, everywhere'
---

### Changed

- Everywhere you could open an agent now says the same thing: **View profile**. The sidebar's "Agent hub", the Team table's "Manage", the status line's right-click menu, the command palette and the topology map all used a different word for the same act, and they all landed somewhere slightly different. One word now, and one place — the profile, which docks beside your session or slides in from the side depending on where you are (DOR-1255)
- Links you saved to the old Agent Hub still work. They open the profile (DOR-1255)
