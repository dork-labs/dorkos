---
covers:
  - 'fix(palette): four kinds of row that were offered and did nothing (DOR-1051)'
  - 'fix(palette): list the commands of the runtime you are actually on (DOR-1051)'
  - 'fix(palette): a channel you archived can be found again (DOR-1051)'
---

### Fixed

- **Rows in the Cmd+K palette that did nothing now do something.** Four kinds of
  row let you highlight them, press Enter, and watch the palette close with
  nothing else happening: slash commands, the "Continue: …" suggestion, the
  recent conversations under an agent, and any row an extension added.
- Picking a slash command takes you to the conversation it would run in and
  types it into the message box for you. It does not send it — you press Enter
  when you are ready. Commands like `/clear` are not ones to fire off from
  across the app with one keystroke, and anything you had already typed is kept.
- "Continue: …" and an agent's recent conversations now open the conversation
  they name, in the right project.
- **The palette lists the commands your agent actually has.** It used to ask
  without saying which conversation you were in, so it always got the default
  runtime's list — you could be talking to Codex and be offered Claude Code's
  commands.
- **A channel you archived can be found again.** Archived channels were gone
  from the whole app. They now turn up in the palette when you search for one,
  marked "Archived", and only there — your sidebar and everything else stay
  free of them.
