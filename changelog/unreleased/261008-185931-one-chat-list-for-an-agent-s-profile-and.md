---
covers:
  - "feat(chats): one chat list for an agent's profile and Switch session (DOR-2789)"
  - 'refactor(chats): remove the lists the chat list replaced, and show it in the playground (DOR-2789)'
  - 'fix(chats): fit the chat list to a phone and keep origin marks to rooms and schedules (DOR-2789)'
  - 'refactor(sessions): remove the session row the chat list replaced (DOR-2789)'
  - 'feat(chats): lift chats that ran out of usage, and line rows up with the controls (DOR-2789)'
  - 'fix(chats): say "just now" for a chat you used seconds ago (DOR-2789)'
  - 'fix(chats): reveal what you need, keep keys in the list, and split the arrangement (DOR-2789)'
---

### Changed

- An agent's chat list and Switch session are now the same list, and they show what needs you first: chats waiting on an approval or a question, chats whose account ran out of usage, and chats that stopped with an error, then chats that are running, then the rest by when you last used them. Each row says when you last used it, like "You · 2h" (DOR-2789)
- Chats that another chat started fold under the chat that started them, behind a "2 spin-offs" toggle. One that needs you is lifted to the top, saying where it started. Chats a schedule or a room started fold into one Automated group at the bottom (DOR-2789)
- Both lists have a New chat button at the top, and you can sort them by For you, Recent activity or when they started (DOR-2789)
