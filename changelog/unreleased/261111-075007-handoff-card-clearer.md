---
covers:
  - 'fix(browser): the handoff card offers one sign-in path, and its buttons fit on a phone (DOR-3112)'
  - 'fix(browser): the agent carries on after a person hands the browser back, and the card says how it ended (DOR-3112)'
---

### Fixed

- When a site needs you, the card in the chat is shorter and clearer. On a check only a person can do, **Show window** comes first, then **Continue**, and a quiet **Sign in instead** is the one way to sign in. On a password page, the card says "{site} needs you to sign in" and offers **Open sign-in window**. A long site name now wraps in the card's title, so no button runs off the edge on a phone. (DOR-3112)
- After you hand the Agent browser back, the agent always carries on, however you did it: **Continue**, or resuming the browser yourself. Before, it only woke up if the card's own message got through. The card then becomes one quiet line saying how it ended: "{agent} is carrying on.", "Stopped. {agent} won't carry on with this." or "The window closed. {agent} stopped here." (DOR-3112)
