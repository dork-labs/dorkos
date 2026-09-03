---
covers:
  - 'feat(client): sign in once and your message sends itself (DOR-1650)'
---

### Changed

- If your agent's sign-in stops working part way through a chat, sign in once from the card and your message goes again on its own. No retyping, and no Retry button to hunt for (DOR-1650)
- It stays out of the way when you have moved on. Started typing something else while signing in? Already have a message running or waiting in line? Then nothing is sent behind your back. The card just says you are signed in and leaves the Retry button there, so the next move is yours. Whatever you typed is left exactly where you typed it
- If you tried again while signing in and hit the same wall, it is the newer message that goes, not the older one. Whichever message the Retry button would have sent is the one that sends itself
