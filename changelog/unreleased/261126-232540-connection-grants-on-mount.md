---
covers:
  - 'feat(api): a caller bar can take the front-door confirm-first hold; the confirm runs the bar afresh and must come from the same kind of caller (DOR-4978)'
  - 'feat(api): letting an agent back in, answering an agent’s request and connecting an account for one move onto the capability mount (DOR-4978)'
---

### Changed

- Letting an agent back into a shared app, answering an agent's request for an app, and connecting an account for an agent's request still ask you to confirm it's you, with the same sheet and request code.
- When you confirm, DorkOS now checks again that you are the owner. A confirmation from anyone else is refused, and your request stays waiting for you.
- These three can also be called by their action name through the API's general "run an action" address. Only you can use them there too; an agent or a program is still refused.
