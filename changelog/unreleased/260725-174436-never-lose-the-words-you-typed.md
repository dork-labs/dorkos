---
covers:
  - 'fix(chat): never lose the words you typed in the composer (DOR-480)'
---

### Fixed

- **Lined-up messages no longer disappear.** If you typed a follow-up while your agent was working and it then stopped to ask you to approve something, your message could vanish without a trace — the "Queued (1)" mark went away and the text was gone. Lined-up messages now wait their turn properly, and if one can't be sent for any reason it goes straight back in the line instead of being thrown away.
- **Every lined-up message now has a "send now" button.** If a reply fails partway through, the messages waiting behind it used to be stuck there with no way to send them — and the only trick people found for getting the text back deleted it. Each one can now be sent on its own, and when sending genuinely isn't possible the button says why.
- **Visiting other conversations no longer deletes messages you lined up.** DorkOS keeps the last 20 conversations in memory; a conversation with messages still waiting to send is now kept regardless.
- **Picking a slash command keeps the rest of your line.** Typing `/deploy staging`, clicking back to just after `/deploy`, then pressing Enter used to delete ` staging` and send nothing at all.
- **A file that fails to upload now says so, and offers to try again.** The chip showed a small red icon with no words, and sending anyway delivered your message with no file attached — so you sat waiting for an answer about something your agent never received. DorkOS now holds the message until you retry the upload or remove the file.
- **Rewriting a message that's waiting in line no longer loses the rewrite.** Moving to another one, or switching to a different conversation and back, keeps what you typed.
- **Coming back to a conversation no longer sends a duplicate.** If you left while editing a message that was waiting in line, its text stayed behind in the box and pressing Enter sent a second copy.
