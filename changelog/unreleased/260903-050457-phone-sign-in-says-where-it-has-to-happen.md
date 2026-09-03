---
covers:
  - 'feat(client,server,shared): give phone and tunnel users an honest re-auth story (DOR-1655)'
---

### Changed

- When you open DorkOS on your phone and an agent's sign-in has stopped working, the card now tells you plainly that signing in needs the computer DorkOS runs on. Before, it showed a Sign in button that always failed, because signing in has to happen on that computer
- The card keeps its Retry button, so once you have signed in over there you can send your message again from your phone with one tap
