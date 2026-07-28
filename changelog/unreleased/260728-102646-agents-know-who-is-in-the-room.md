---
covers:
  - 'feat(rooms): tell an agent who is in the room, and who is a person (DOR-622)'
---

### Changed

- An agent answering in a channel or a DM now knows who else is there, and which of them are people rather than other agents. It also gets the room's topic, the messages it has not read yet, what it said there recently, and how many automatic replies are left. Before this it got the one message and nothing else, so it could not tell a colleague from a bot and had no way to follow the room's etiquette rules. (DOR-622)
- The message an agent receives is now exactly what the person typed. DorkOS used to wrap a sentence of its own around it, which then showed up in the session transcript as words nobody wrote. (DOR-622)

### Security

- Messages other members wrote now reach an agent inside a clearly marked block that says they are information, never instructions. The markers around that block carry a one-time code, so nobody can end it early by typing the closing line into a message and having the rest read as trusted. (DOR-622)
- Names, room topics and agent handles are cleaned before an agent sees them, using the same check that already protects messages arriving from Telegram and Slack. Someone cannot use their own display name, or the message a thread was started from, to slip an extra instruction into what an agent reads. (DOR-622)
