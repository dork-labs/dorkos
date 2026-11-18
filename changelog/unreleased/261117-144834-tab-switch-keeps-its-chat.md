---
covers:
  - 'fix(client): a late send or chat lookup never rewrites the chat you switched to (DOR-4622)'
  - 'fix(client): overtaken opens stay quiet without breaking redirects, and background tabs keep the renamed chat (DOR-4622)'
---

### Fixed

- **Switching chats right after you send no longer swaps them.** If you sent a message and quickly switched to another tab, that tab could turn into the chat you had just sent to. The same thing could pull you back after you clicked a different chat in the sidebar. Now the chat you switch to stays put. A new chat, a fork or an agent's chat that is still opening also stays out of your way if you have already moved on. (DOR-4622)
