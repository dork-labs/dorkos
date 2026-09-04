---
covers:
  - 'fix(client): sheets, the sidebar and the right panel move on the timing system (DOR-1764)'
  - 'fix(client): the send button and the top-bar icons stop jumping under the cursor (DOR-1764)'
  - 'fix(client): two panels that vanished in one frame now fade out (DOR-1764)'
  - 'fix(client): a long Inbox stops reading as a slow Inbox (DOR-1764)'
  - 'refactor(client): delete three keyframe blocks nothing wears (DOR-1764)'
  - 'refactor(client): every transition names the properties it moves (DOR-1764)'
  - 'fix(client): the identity disc and the dropdown rejoin their own grammars (DOR-1764)'
  - 'feat(client): one answer to "how does a selection move" (DOR-1764)'
  - 'feat(client): the page cross-fades with the chrome that describes it (DOR-1764)'
  - 'fix(client): sliding indicators are scoped by construction, not by convention (DOR-1764)'
  - 'feat(client): the copy button answers with motion, because the motion is the answer (DOR-1764)'
  - 'fix(client): the border pulse gates itself, so a barrel cannot hand out an endless one (DOR-1764)'
---

### Changed

- Side panels open in a fifth of a second instead of half a second, and the dark backdrop
  now arrives with the panel instead of ahead of it (DOR-1764)
- The sidebar and the right panel open without that little pause before they start moving
  (DOR-1764)
- The send button and the two icons in the top bar no longer grow under your mouse. They
  light up instead, the way the rest of the buttons do (DOR-1764)
- Picking one of a few side-by-side choices — like how much freedom you give an agent —
  now slides the highlight across instead of blinking it to the new spot (DOR-1764)
- Pages fade in when you switch between Home, Team and the rest, so the page keeps up with
  the menu beside it (DOR-1764)
- Copying something now shows the checkmark with a small fade, so you can see it worked
  (DOR-1764)

### Fixed

- A busy Inbox shows up right away. It used to trickle in one row at a time, which looked
  like it was loading slowly (DOR-1764)
- The recent-chats panel above the message box, and a project card you just added during
  setup, fade away instead of vanishing mid-blink (DOR-1764)
- Menus now open outward from the button you clicked, and one near the edge of the screen
  slides in from the right direction (DOR-1764)
- If you have asked your system for less on-screen movement, a busy conversation's glowing
  border now stays still (DOR-1764)
