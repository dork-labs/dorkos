---
covers:
  - 'feat(client,shared): you can find a message by what was said in it (DOR-685)'
---

### Added

- **Search your messages.** Press `⌘⇧F` (`Ctrl+Shift+F` on Windows and Linux) and type what you remember somebody saying. DorkOS looks through your channels, your direct messages and your Claude Code conversations at once, shows you the sentence it found with your words picked out, and takes you to the conversation it was said in. (DOR-685)
- The box tells you what it can and cannot see. Before you type anything it says which conversations it searches and which it does not, that tool output and file contents are never searched, and that it matches whole words — so `ogs` will not find `dogs`, but `dog*` will. Nothing about the edges of search is left for you to discover by getting no results. (DOR-685)
- `⌘K` now offers **"Search messages for …"** as its last row, carrying whatever you already typed. `⌘K` still finds things by their name — an agent, a channel, a conversation — and the new box finds them by what was said inside them. They stay two separate boxes on purpose. (DOR-685)
- A conversation whose project folder has been deleted still turns up, and still opens: you can read what was said, and DorkOS tells you the folder is gone rather than failing. (DOR-685)
