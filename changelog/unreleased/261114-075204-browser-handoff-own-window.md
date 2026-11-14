---
covers:
  - 'fix(server): an agent handing over the browser in its own window hears it was handed over (DOR-4325)'
  - 'fix(client): the browser panel says it is waiting for you during a sign-in, and shows the server’s refusals (DOR-4325)'
  - 'fix(client): the browser panel names Continue in the chat, and shows a new sign-in at once (DOR-4325)'
---

### Fixed

- When the Agent browser opens in its own window and your agent hands it to you to sign in, your agent now hears that it handed it over and waits. Before, it was told the browser wasn't open.
- While your agent waits for you to sign in, the browser panel says "Waiting for you" and where to finish, instead of "Not open yet" with an Open browser button.
- The browser panel now shows what went wrong when it can't open, such as "Finish signing in first," instead of always saying it couldn't reach the browser.
