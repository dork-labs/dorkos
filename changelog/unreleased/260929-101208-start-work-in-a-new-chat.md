---
covers:
  - 'feat(extensions): start work in a new chat from an extension (DOR-2524)'
  - 'feat(chat): say who started a chat and fold what it was asked (DOR-2524)'
  - 'fix(extensions): count and name a started chat across a move to another account, and say it is an extension (DOR-2524)'
  - 'fix(extensions): never refuse moving a started chat to another account, and keep who started a chat for as long as the chat (DOR-2524)'
  - 'feat(extensions): refuse a start where no account may work, through the real account ladder (DOR-2524)'
  - 'fix(client): keep the phone and tablet header inside its row when the bell shows a number (DOR-2524)'
---

### Added

- An extension's button can now start work in a new chat with one click. The chat you are in, and anything you have typed there, stays as it was. The new chat has a plain title, and its first line says who started it and why, like "Started by the Flow extension: 12 new ideas were waiting to be sorted". What it was asked is folded under "What it was asked" so it is there when you want it. (DOR-2524)
- A chat that an agent starts from another chat now says so as its first line, with a link back to the chat it came from. (DOR-2524)
- The chats an extension starts are limited: at most 10 an hour and 3 working at once, counting the chats those chats start. Continuing one of those chats on another account is never blocked by these limits. Chats started other ways, like schedules and rooms, have limits of their own. (DOR-2524)
- A chat an extension starts uses an account the same way any new chat does, so an account kept to other projects is never used, and a project no account may work in says so instead of starting. (DOR-2524)

### Fixed

- On a phone or tablet, the top bar no longer spills past the edge when the inbox bell shows a number. The bell keeps its size and shows the number as a small badge on its corner. (DOR-2524)
