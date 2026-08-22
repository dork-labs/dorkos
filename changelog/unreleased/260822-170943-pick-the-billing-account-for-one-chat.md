---
covers:
  - 'feat(client,shared): pick the billing account for a single chat (DOR-1407)'
  - 'fix(client): the account picker tells the truth about what it will bill (DOR-1407)'
  - 'fix(client): only a positive registry read may end a billing pick (DOR-1407)'
  - 'fix(client): a pre-launch pick carries the session it was made in (DOR-1407)'
---

### Added

- You can now bill one chat to a different Claude account without changing anything else. Before you send the first message, open the runtime chip in the status bar and pick an account — it applies to that chat and nothing after it. The menu says so: "This session only. Locked once the first message sends."
- The menu also names what "Default" would actually charge, so leaving it alone is still a choice you can see. If the agent working in that folder is set to bill a particular account, that is the one it names — not whatever your machine falls back to otherwise.

### Changed

- Picking an account from the status bar no longer changes the setting for every future chat. It used to, quietly, which is how work ended up billed to the wrong client with no sign anything had happened. The account every new chat starts on now lives in one place, Settings → Runtimes → Claude Code, and is called **Default account**: "New sessions bill this account unless the agent or the session picks another."
