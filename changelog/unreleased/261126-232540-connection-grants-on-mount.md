---
covers:
  - 'feat(api): a caller bar can take the front-door confirm-first hold; the confirm runs the bar afresh and must come from the same kind of caller (DOR-4978)'
  - 'feat(api): letting an agent back in, answering an agent’s request and connecting an account for one move onto the capability mount (DOR-4978)'
  - 'fix(api): the caller-bar confirm runs only on a confirm, the agent-request answer follows its client, and the rows pin a fresh pass on both bars (DOR-4978)'
---

### Changed

- Letting an agent back into a shared app, answering an agent's request for an app, and connecting an account for an agent's request still ask you to confirm it's you, with the same sheet and request code.
- When you confirm, DorkOS now checks again that you are the owner. A confirmation from anyone else is refused, and your request stays waiting for you.
- These three can also be called by their action name through the API's general "run an action" address. Only you can use them there too; an agent or a program is still refused.
- Confirming one of these a different way than you asked (asked over your own tunnel, confirmed at the computer) now says "That took too long. Nothing changed." Ask again the way you'll confirm.
- If you lose the right to change connected apps before you confirm, the sheet now says "That took too long. Nothing changed." before asking for your password, instead of refusing after it.
- With agents' requests turned off, a badly formed answer to one now gets the usual "the request is wrong" message first, instead of the "agents' requests aren't available" one.
