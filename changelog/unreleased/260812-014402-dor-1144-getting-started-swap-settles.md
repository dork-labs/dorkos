---
covers:
  - 'fix(client): Getting started stops flickering every time an agent starts or stops (DOR-1144)'
---

### Fixed

- On a new setup, the **Getting started** list at the top of the sidebar used to disappear and
  snap back every time an agent started or finished working, shoving everything below it up and
  down the screen. It still steps aside straight away when something actually needs you — that
  part matters more — but it now waits a few seconds before coming back, and it never returns
  while your mouse is in the sidebar or you are moving through it with the keyboard. Short bursts
  of agent activity no longer move anything (DOR-1144)
