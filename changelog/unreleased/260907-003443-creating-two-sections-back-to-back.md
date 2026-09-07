---
covers:
  - 'fix(client,e2e): creating two sections back-to-back no longer eats a click (DOR-1834)'
  - 'test(e2e): the home-indicator guard waits for the footer it measures (DOR-1834)'
---

### Fixed

- Creating two sidebar sections one after the other no longer eats a click. Right after naming a section, the next press on "New" did nothing and you had to press it again — the menu that had just closed was still on screen finishing its fade, and it was closing the menu your press had opened. The same press now works the first time, anywhere in the app a menu is reopened straight after it closed (DOR-1834)
