---
covers:
  - 'feat(client): on your phone the sidebar is four tabs, and the drawer is gone (P4.1, DOR-1077)'
  - 'fix(client): the phone tabs yield on the navigation commit, and the page they cover goes inert (P4.1 review, DOR-1077)'
  - 'test(client,e2e): pin the third scan dir, restore the yield assertion, fix a number in a comment'
  - 'fix(client,e2e): the mobile badge was 2.15:1, and the showcase drew four identical landmarks (P4.1, DOR-1077)'
---

### Changed

- On your phone, DorkOS now has four tabs along the bottom instead of a slide-out
  menu. **Home** shows what needs you and what you were working on today, with a
  count on the tab when your agents are waiting. **Library** is your channels,
  direct messages, agents and pins, and it never shows a count — it is the quiet
  one. **DorkBot** opens a conversation with the assistant that knows how DorkOS
  works. **You** holds your account and the rest of the app. The hamburger button
  is gone: nothing has to be swiped away before you can use what is underneath,
  and switching tabs keeps your place in each one.
