---
covers:
  - 'feat(rooms): one @ picker for people and agents, and it writes a name that works (DOR-631)'
---

### Added

- Type `@` in a channel or a direct message and a list of everyone in it appears — people first, then agents. Pick one and the message is addressed to them: an agent you name will answer, a person you name just gets told. Arrow keys move through the whole list, Enter takes the highlighted one, and typing narrows it down.
- The picker writes the name that actually reaches someone, which is not always the name on screen. An agent called "Mio Clicker PM" answers to `@mio-clicker-pm`, and typing its full name by hand reaches nobody at all. Pick it from the list and the right thing gets written for you.
- An agent that no `@` name can reach still shows up in the list, greyed out and saying so, instead of quietly going missing.

### Changed

- A name nobody in the room has stays ordinary text. `@99` in "refunded @99" is a number, and an email address is an email address — neither is a failed mention, so neither is treated as one. Pressing Enter sends the message as usual.
