---
covers:
  - 'fix(desktop): the Mac app keeps agent activity and notifications when it asks for a password (DOR-4691)'
---

### Fixed

- The Mac app shows agent activity in the menu bar and sends notifications again when "Ask for a password on this computer too" is on. Before, it stopped showing both, with no message. Now it uses the window's sign-in. It reconnects as soon as you sign in, and after DorkOS restarts.
