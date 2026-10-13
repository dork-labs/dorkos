---
covers:
  - '#2855'
  - 'feat(trust): agents are trusted by default, with a one-time notice (DOR-2739)'
---

### Changed

- Agents now work on their own. A new install starts on **Trusted**: every area is Allowed except Safety limits and Reach & secrets, which still ask, and a chat edits files and runs commands without stopping to check with you. **Careful**, for anyone who would rather approve things by hand, is the other choice. Updating an existing install moves you to Trusted once and shows a one-time note, "Agents now work without asking," unless you had already chosen Careful or told DorkOS to keep asking you (DOR-2739)
- Removing a package, deleting a scheduled task, and removing an agent now run and land in your activity feed on Trusted, instead of waiting for a card. Changing an agent's safety boundaries or what it runs on, and running a package from a folder, still always ask (DOR-2739)
- On Trusted, your agents can message each other across projects by default. DorkOS turns this on once, the first time it starts; turning it off in Team → Access keeps it off from then on. A Careful install is left as it was (DOR-2739)
- A schedule one of your agents proposes for itself starts running right away on Trusted, with a notification and a **Pause** button, instead of waiting for your approval. On Careful it still waits (DOR-2739)
- A mini app your agent builds for you with `create_extension` turns on by itself on Trusted, bound to the exact folder and the permissions it asked for at the time. On Careful it still waits for you (DOR-2739)
- On Trusted, your agents can change permissions too, and each change lands in the history with the agent's name. To keep a setting no agent can undo, set the Permissions area itself to Ask or Blocked. Installing or updating a package still asks, on any preset (DOR-2739)
- A tool or script DorkOS can't place as one of your agents, and an agent whose turn someone outside your team started, still have to ask before an action with no undo or any change to permissions, on any preset (DOR-2739)
- A new Telegram or Slack connection now lets its agent start conversations by default on Trusted (DOR-2739)

### Note for people upgrading

- If you see the "Agents now work without asking" note, **Got it** keeps your agents working the new way; **Keep asking me** switches you to Careful and keeps anything you set to Blocked, so your agents keep asking first. Either answer, the note shows once and does not come back (DOR-2739)
