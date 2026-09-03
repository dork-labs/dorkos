---
covers:
  - 'fix(client): the Button primitive answers a press (DOR-1751)'
  - "fix(client): the phone's tab bar answers a tap (DOR-1751)"
  - 'fix(client): tool cards answer the mouse and the keyboard (DOR-1751)'
  - 'fix(client): collapsibles open instead of teleporting (DOR-1751)'
  - 'refactor(client): let card-interactive own its own transition (DOR-1751)'
  - 'fix(client): only actionable activity rows look actionable (DOR-1751)'
  - 'fix(client): the checkbox stops being the one control with no transition (DOR-1751)'
  - 'fix(client): hand-rolled rows fade their hover instead of flashing (DOR-1751)'
  - 'refactor(client): one press ladder, three stops (DOR-1751)'
---

### Changed

- Buttons give a little squeeze when you press them, everywhere in the app — the same small answer a sidebar row already gave (DOR-1751)
- Tapping a tab on your phone answers right away, instead of waiting for the next screen to load (DOR-1751)
- Sections that fold open — in Settings, Connections, agent setup and onboarding — slide instead of jumping (DOR-1751)
- Rows in a table are easier to see under the mouse, especially in dark mode (DOR-1751)
- Checkboxes pop in when you tick them, like the switches beside them (DOR-1751)

### Fixed

- Tool and thinking cards in a chat answer the mouse now, and their headers show a focus ring for people using a keyboard (DOR-1751)
- Activity rows that lead nowhere no longer look clickable or take a keyboard stop (DOR-1751)
- Cards that lift under the mouse do the same for a keyboard, so nobody learns less by not using a mouse (DOR-1751)
- Menu and list rows fade between highlights instead of flashing (DOR-1751)
