---
covers:
  - 'feat(rooms): a direct message is idempotent on its member set (DOR-571)'
  - 'feat(rooms): pick several agents for one direct message (DOR-571)'
  - 'fix(rooms): address review on #522 — two picker defects and the create status'
---

### Added

- A direct message can hold several agents. The "+" beside Direct messages now lets you pick more than one: type a name and press Enter to add it, then keep going. Everyone you pick shows as a tag, so you can see who is in the conversation before you open it. One agent gives you a one-to-one; two or more give you a group named after the people in it. Backspace takes back the last agent you added, and Escape closes without opening anything (DOR-571)

### Changed

- Asking for a conversation you already have opens that one instead of making a second copy. DorkOS now recognises a direct message by exactly who is in it, so picking the same people again takes you back to the same place, history and all — and if you had archived it, it comes back out. It keeps its name and its place in the list, because opening a conversation is not the same as something happening in it. "You and Ana" and "You, Ana and Kai" are still different conversations, so every agent stays available whether or not it already has one (DOR-571)
- If you drive DorkOS through the API, `POST /api/rooms` now answers `201` when it made a room and `200` when it handed you one that already existed. The two replies look identical otherwise, so this is the only way to tell a brand-new conversation from one with a month of history in it (DOR-571)
