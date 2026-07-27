---
covers:
  - 'feat(rooms): a direct message is idempotent on its member set (DOR-571)'
  - 'feat(rooms): pick several agents for one direct message (DOR-571)'
---

### Added

- A direct message can hold several agents. The "+" beside Direct messages now lets you pick more than one: type a name and press Enter to add it, then keep going. Everyone you pick shows as a tag, so you can see who is in the conversation before you open it. One agent gives you a one-to-one; two or more give you a group named after the people in it. Backspace takes back the last agent you added, and Escape closes without opening anything (DOR-571)

### Changed

- Asking for a conversation you already have opens that one instead of making a second copy. DorkOS now recognises a direct message by exactly who is in it, so picking the same people again takes you back to the same place, history and all — and if you had archived it, it comes back out. "You and Ana" and "You, Ana and Kai" are still different conversations, so every agent stays available whether or not it already has one (DOR-571)
