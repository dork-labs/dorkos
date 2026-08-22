---
covers:
  - 'feat(client): a reload paints the sidebar from local memory, instantly (DOR-1373)'
  - 'fix(client): Getting started no longer grows in at the top of a sidebar that has finished painting (DOR-1373)'
  - 'test(client): the boot-cache tests spell the config key through its factory (DOR-1373)'
  - 'fix(client): a change you just made survives the reload that follows it (DOR-1373)'
  - 'fix(client): a returning user is never shown the first-run wizard again (DOR-1373)'
---

### Changed

- Reloading the cockpit no longer opens with a second of empty panel. DorkOS remembers what your
  sidebar looked like last time — your channels, your agents, today's conversations, your pins —
  and paints the finished panel in the first frame, then quietly checks with the server behind it
  and updates anything that moved (DOR-1373)

### Fixed

- The Getting started suggestions appear with the rest of the panel instead of arriving a moment
  later and pushing everything below them down (DOR-1373)
- Something you just changed, like a card you dismissed, a section you made, or a room you muted,
  is what the next load starts from, even if you reload the moment after (DOR-1373)
- The setup wizard no longer appears over an install that finished setting up long ago. For a
  moment while DorkOS read your saved settings, it could decide you were brand new and put the
  welcome screen up. It now waits for your real settings first (DOR-1373)
- A damaged saved copy of your sidebar no longer stops the app opening. DorkOS throws it away and
  loads fresh instead (DOR-1373)

### Security

- What the cockpit remembers is tied to the address it was talking to, so two DorkOS installs open
  in one browser never show each other's channels. It is forgotten when you sign out, when you
  update DorkOS, and after a day. Your conversations are never kept in the browser — and neither
  is anything waiting on your answer, so you are never shown a stale "three things need you"
  (DOR-1373)
