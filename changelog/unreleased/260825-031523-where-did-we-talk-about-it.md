---
covers:
  - 'feat(server): one request answers "where did we talk about X" (DOR-684)'
  - 'feat(server): a room message is findable the moment it is said (DOR-684)'
---

### Added

- You can now ask DorkOS where something was said, and get an answer back in one request: `GET /api/search?q=…` looks through your rooms and your Claude Code chats at once and returns the best matches, each with the sentence it was in and the words you searched for marked. The search box you will click is still on its way (DOR-684)
- Results come back ranked together rather than sorted by where they came from, because "where did we talk about the scheduler" does not know whether you said it in a channel or to an agent (DOR-684)
- Searching matches whole words, including their other forms: look for `dogs` and you will find "dog", "dogs" and "DOGGED". A piece of a word, like `ogs`, finds nothing (DOR-684)
- Each result carries what it needs to be opened later — which chat or room it was in, where in it, who said it, and when (DOR-684)

### Changed

- Anything said in a room can be found straight away, instead of after the next few-minute catch-up. Claude Code chats still take up to five minutes to show up, because DorkOS has to notice the file changed rather than being told (DOR-684)

### Security

- Your own chats with agents stay yours. An agent searching gets only the rooms it is actually in, and only from the point it joined — never what was said in a room before it arrived, and never anything from your Claude Code sessions (DOR-684)
- Asking about something you are not allowed to see gets exactly the same answer as asking about something nobody ever said, so a search can never be used to find out that a private room exists (DOR-684)

### Fixed

- If one place DorkOS reads from cannot be read, search still answers with everything else and tells you one of its sources is behind — rather than failing the whole request or quietly returning a short list (DOR-684)
- Sending a message can never fail because the search copy could not be updated. The room keeps your message either way, and the next catch-up adds it to search (DOR-684)
