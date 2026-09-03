---
covers:
  - 'feat(client,server,shared): give phone and tunnel users an honest re-auth story (DOR-1655)'
  - 'fix(client,server): apply adversarial review — real parity coverage, Settings guard, no-store'
---

### Changed

- When you open DorkOS on your phone and an agent's sign-in has stopped working, the card now tells you plainly that signing in needs the computer DorkOS runs on. Before, it showed a Sign in button that always failed, because signing in has to happen on that computer
- Settings says the same thing on the same screen where you would otherwise press Connect, so the app no longer tells you two different stories two clicks apart
- The card keeps its Retry button, so once you have signed in over there you can send your message again from your phone with one tap
