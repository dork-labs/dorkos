---
covers:
  - 'refactor(rooms): the members dialog becomes the room details sheet'
  - 'feat(ui): IdentityAvatar can mark an agent apart from a person'
  - 'feat(rooms): the cockpit can read the engaged-window numbers'
  - 'feat(rooms): how loud an agent is becomes a scale you can rank'
  - 'fix(rooms): the loudness scale runs quiet to loud on a phone too'
  - 'feat(rooms): the room says how loud it is, in one sentence'
  - 'feat(rooms): loudness becomes a place you point at, not a word you pick'
  - 'feat(rooms): a member becomes a line, not a card'
  - "feat(rooms): a room's name and topic are edited where you read them"
  - 'feat(rooms): adding an agent is the last row of the roster'
  - 'feat(rooms): one sheet for everything about a room'
  - 'feat(rooms): a loudness change shows up the moment you make it'
  - 'feat(rooms): taking an agent out of a room can be undone'
  - 'feat(rooms): an archived room stops pretending its settings are live'
  - 'feat(rooms): a one-to-one says what a second agent would do to it'
  - "feat(rooms): the room sheet's empty and broken states lead somewhere"
  - 'feat(rooms): point at a loudness setting and the room says what it would become'
  - 'feat(rooms): agents arrive and leave a room instead of blinking in and out'
  - 'feat(rooms): the room sheet fits a phone'
  - 'fix(rooms): two controls a thumb could miss on a phone'
  - 'fix(rooms): a one-to-one gets the reply window too'
  - 'fix(rooms): pressing the setting you already have writes nothing'
  - 'fix(rooms): two removals at once, two ways back'
---

### Changed

- **You can finally see and understand when each agent speaks.** The members panel is now a room sheet, and it holds everything about the room in one place: its name and topic at the top, one line saying what the room will actually do, everyone who is in it — you included — a row that adds an agent, and when the room was made. Archiving is at the foot.
- **How loud an agent is has become a scale you point at.** It used to be five sentences that all began with "Replies", in an order nobody could work out. Now each agent has a spot on a quiet-to-loud scale — **Silent**, **@only**, **Engaged**, **Everything** — and pressing it opens the scale with the real rule written underneath, including the actual number of minutes and messages your DorkOS keeps an agent talking after you mention it, read from your own settings rather than guessed.
- **A one-to-one gets the same four settings a channel does.** **Engaged** — answers when you say its name, then keeps answering for a while — used to be missing from direct messages, on the idea that nobody says a name in a two-person chat. That was wrong: add a second agent and it is still a direct message, and it is exactly the room where you want an agent that answers when spoken to and then goes quiet. If one of your agents was already set that way, its setting now shows as **Engaged** instead of quietly reading as **@only**.
- **Point at a setting and the room tells you what it would become.** Move the mouse across the scale, or arrow through it, and the line at the top of the sheet shows what the whole room would do if you chose that — tinted to say it is a "what if". Stop pointing and it goes back. Nothing is saved until you actually pick one, and an archived room shows no such preview, because nothing would be true.
- **A change lands the moment you make it.** The meter moves straight away instead of waiting for the server. While it saves, the setting dims; if the save is refused it goes back to what is really stored and says why — so you are never looking at a value that was never saved.
- **Each person or agent is a line, not a card**, with its face, what it is doing right now or the last thing it did here, and its loudness on the right. Agents carry a small robot mark; people carry none.
- **A room's name and topic are edited where you read them.** Press the line, type, press Enter — Escape puts it back. A channel with no topic says "Add a topic" instead of leaving a gap.
- **Adding an agent is the last row of the list of who is in the room**, rather than a second panel with its own heading. Press it and it becomes the picker, cursor already in it.
- **An archived room stops pretending.** Every meter goes grey and the scales cannot be changed, because nothing is triggered in an archived room. The settings are still shown — they are what each agent will do the moment you bring the room back — and the sheet says so where a screen reader will read it too.
- **Opening the sheet for a room with nobody in it opens the picker straight away.** A room with nobody in it does nothing, so putting somebody in it is the only thing worth offering. "You have not added any agents yet" now comes with a **Create agent** button, and a roster that could not be read now offers **Try again** instead of asking you to close the sheet and open it again.
- **Rows in the roster are taller on a touch screen**, so a face and two lines read as a person rather than as a dot with a caption.

### Added

- **One line at the top of the sheet says what the room will actually do** — "Two agents will answer you here", "Only @mentions get an answer here", "There is nobody here to answer you" — with a small meter beside it. It names the odd one out when there is exactly one worth naming.
- **Taking an agent out of a room can be undone**, the way archiving a whole room already could. Putting it back restores how loud it was, rather than resetting it to what a brand-new arrival gets.
- **A one-to-one says what a second agent would do to it** — "Adding a second agent turns this into a group conversation" — before you add one, instead of leaving you to work it out from the faces afterwards.
- **Agents arrive and leave instead of blinking in and out.** An agent you add opens into place and glows once, so you can see where it went. One you remove collapses its row, so the **Undo** offer refers to something you watched happen. Opening a scale slides it open. An agent that is working has a pulsing dot rather than a still one. All of it stops moving — without anything disappearing — if your system is set to reduce motion.

### Removed

- **The separate topic dialog.** "Edit topic…" now opens the room sheet with the topic line ready to type in, instead of a window holding one text box.

### Fixed

- A room with a lot of agents in it no longer grows the sheet off the top of the screen. It stops at a readable height and the middle scrolls, the way every other panel in DorkOS does.
- Opening the sheet on a phone no longer pops the keyboard at you. The search box is still the first thing under the heading, and still one tap away — you just get to look at the list first.
- Two controls on a phone were a few pixels too small to hit reliably: an agent's loudness setting, and the **×** that takes an agent back off the list while you are choosing. Both are now comfortably thumb-sized.
- Pressing the loudness setting an agent already has now does nothing, instead of quietly saving it again — which could fail, and could change how the setting was stored without changing what the agent does.
- Taking two agents out of a room one after the other now offers **Undo** for both. The first offer used to be dropped if the second removal started before it finished, leaving one agent gone with no way to put it back on the setting it had.
