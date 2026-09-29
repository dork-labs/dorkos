---
covers:
  - 'feat(extensions): start work in a new chat from an extension (DOR-2524)'
  - 'feat(chat): say who started a chat and fold what it was asked (DOR-2524)'
  - 'fix(extensions): count and name a started chat across a move to another account, and say it is an extension (DOR-2524)'
---

### Added

- An extension's button can now start work in a new chat with one click. The chat you are in, and anything you have typed there, stays as it was. The new chat has a plain title, and its first line says who started it and why, like "Started by the Flow extension: 12 new ideas were waiting to be sorted". What it was asked is folded under "What it was asked" so it is there when you want it. (DOR-2524)
- A chat that an agent starts from another chat now says so as its first line, with a link back to the chat it came from. (DOR-2524)
- The chats an extension starts are limited: at most 10 an hour and 3 working at once, counting the chats those chats start and moves to another account. Chats started other ways, like schedules and rooms, have limits of their own. (DOR-2524)
