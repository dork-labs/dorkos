---
covers:
  - 'feat(client): press and hold a row for what you can do, and everything is big enough to tap (P4.2, DOR-1078)'
---

### Added

- **Press and hold any row on your phone** to get the same list of things you can
  do that a right-click gives you on a computer — mute a channel, move an agent
  into a group, rename, archive. It rises from the bottom of the screen with
  everything in one list, so nothing is hidden behind a second menu. A press that
  turns into a scroll never opens it, and it never opens the conversation you
  were only trying to scroll past.
- **"Catch up" at the top of Today** clears every unread conversation in one tap.
  It only shows up on a phone, and only when there is something to clear.
- **Approvals now appear in Home on your phone**, with Allow and Don't allow
  right on the card. You can unblock an agent from the queue for coffee without
  opening anything. If DorkOS cannot check whether something is waiting, it says
  so and offers to try again rather than showing you an empty screen.

### Changed

- **Everything you tap on a phone is now big enough to tap.** Rows, section
  headings, the menu buttons, "New", the search bar and the four places DorkOS
  goes are all at least 44 pixels tall. Two small controls that could not grow
  without covering the row's own words — the face that opens an agent's profile
  and the "N live" chip — moved into the press-and-hold menu instead, along with
  a new way to switch between an agent's conversations.
- **The You tab now says what each thing is.** The four destinations were
  unlabelled icons whose only names appeared when you hovered over them, which
  never happens on a touch screen. They are named rows now, and your account sits
  among them instead of behind a "…".
- The tab you are on is easier to see: it was marked with a shade of grey almost
  identical to the others.

### Fixed

- **A sidebar section's menu is reachable on a phone again.** Rename, sort, mute
  and delete-group sat behind a button that only appeared when you hovered — so
  on a touch screen there was no way to reach them at all.
- The count of agents waiting on you is now announced to a screen reader wherever
  you are. It used to be announced only from inside the Home tab, which is put
  away whenever you are reading a conversation — exactly when an agent is most
  likely to start needing you.
