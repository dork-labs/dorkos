---
covers:
  - 'fix(chat): never lose the words you typed in the composer (DOR-480)'
  - 'fix(chat): close the last ways a composer message could still be lost (DOR-480)'
  - 'fix(chat): a command typed into the queue runs instead of stranding it (DOR-480)'
  - 'fix(chat): a queued /rename always settles, even if the composer goes away (DOR-480)'
---

### Fixed

- **Lined-up messages no longer disappear.** If you typed a follow-up while your agent was working and it then stopped to ask you to approve something, your message could vanish without a trace — the "Queued (1)" mark went away and the text was gone. Lined-up messages now wait their turn properly, and if one can't be sent for any reason it goes straight back in the line instead of being thrown away.
- **Every lined-up message now has a "send now" button.** If a reply fails partway through, the messages waiting behind it used to be stuck there with no way to send them — and the only trick people found for getting the text back deleted it. Each one can now be sent on its own, and when sending genuinely isn't possible the button says why.
- **Visiting other conversations no longer deletes messages you lined up — or a message you started typing.** DorkOS keeps the last 20 conversations in memory, and used to drop the oldest one whether or not it still held your words. A conversation with something waiting to send, or half-typed in the box, is now kept regardless.
- **Picking a slash command keeps the rest of your line.** Typing `/deploy staging`, clicking back to just after `/deploy`, then pressing Enter used to delete ` staging` and send nothing at all.
- **A file that fails to upload now says so, and offers to try again.** The chip showed a small red icon with no words, and sending anyway delivered your message with no file attached — so you sat waiting for an answer about something your agent never received. DorkOS now holds the message until you retry the upload or remove the file.
- **Typing a command into a message that's waiting in line now just runs it.** Commands like `/compact` or `/rename` do something right away rather than getting sent to your agent, so one sitting in the line used to jam it — everything queued behind it waited forever. Now it runs when you press Enter, and if it can't run (a missing name, say) your text stays put so you can fix it.
- **Rewriting a message that's waiting in line no longer loses the rewrite.** Moving to another one, or switching to a different conversation and back, keeps what you typed.
- **Coming back to a conversation no longer sends a duplicate.** If you left while editing a message that was waiting in line, its text stayed behind in the box and pressing Enter sent a second copy.
