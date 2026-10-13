---
covers:
  - "feat(trust): a 60-second cancel window before an agent's irreversible action in a connected app (DOR-2739)"
  - '#2878'
---

### Added

- On Trusted, when an agent working on its own takes an action in a connected app that can't be taken back, like deleting or sending an email, DorkOS holds it for 60 seconds first. Every open DorkOS window shows a notification in the Inbox with **Cancel**, and your phone gets one too if you turned phone alerts on. Clicking the alert opens the Inbox right on it (DOR-2739)
- Anyone can cancel a waiting action, a person or another agent, except the agent that asked. A cancelled action never runs, and the agent is told who cancelled it. Stopping the chat cancels it too. If DorkOS restarts while it waits, it is dropped and never runs; if it restarts just as the action is sent, the notification says it may have run and which app to check (DOR-2739)
- If nobody cancels, DorkOS checks once more that it still may run without asking, then runs it exactly as asked, on the same account, and a second notification says it ran. If the notification can't be shown or the action can't be recorded, you get an approval card instead. This is a cancel, not an undo. On Careful, in a chat that asks first, or when someone outside your team started the chat, you still get an approval card (DOR-2739)
