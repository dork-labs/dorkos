---
covers:
  - "fix(rooms): the DM picker gets the screen on a phone (DOR-602)"
  - "fix(rooms): the picker survives a landscape phone with the keyboard up (DOR-602)"
  - "fix(rooms): the chip's remove target stops stealing taps from the field (DOR-602)"
---

### Fixed

- Starting a direct message works on a phone. The "+" beside Direct messages used to open a small floating panel pinned to a button the phone sidebar had already covered up — on a narrow screen it was drawn off the left edge entirely. It now opens a full-screen sheet: the search box sits at the top where the keyboard can't hide it, the list of agents has room to scroll, and there's an X to close it. Turn the phone sideways and it still works: the heading steps aside so you can see who you're picking. On a tablet or a computer it stays the same compact panel it always was.
- Typing a channel name in the sidebar is easier to tap and easier to read on a phone.
