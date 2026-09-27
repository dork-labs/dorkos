---
covers:
  - 'feat(connections): one list of apps with a side panel per app (DOR-2418)'
  - 'test(connections): cover the one list, the side panel and Needs you (DOR-2418)'
  - 'feat(connections): browser specs, docs and copy follow the one list (DOR-2418)'
  - 'fix(connections): every door into Connections lands on the list (DOR-2418)'
  - 'docs(decisions): the Connections page is one list of apps (DOR-2418)'
  - 'docs(api): regenerate the providers response schema (DOR-2418)'
  - 'fix(connections): hand focus back when the panel closes (DOR-2418)'
---

### Changed

- The Connections page is now one simple list of apps. **Yours** shows everything you connected, one row each, with what state it is in and the one thing to do next: an app that signed out turns amber and moves to the top with **Sign in again**, a paused one is greyed with **Resume**. **All apps** shows everything else you can connect, sorted by kind, with the popular apps always there. Chat apps such as Telegram and Slack sit in the same list with a small **Chat** tag (DOR-2418).
- Click a connected app to open its side panel: who can use it, what agents did with it lately, and a few one-click prompts that open a chat with the message already typed. Its name, notifications, exact actions, pause and disconnect are under **More**. A chat app's panel shows who answers it and anyone waiting for an answer (DOR-2418).
- When an agent asks to use an app, or a program asks to change one, it shows in a small **Needs you** strip at the top of the page, and only then (DOR-2418).
- Settings › Connections marks **Used for new apps** on the way DorkOS connects new apps through, when you have more than one, and keeps the chat app message history under a fold (DOR-2418).
