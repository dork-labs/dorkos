---
covers:
  - "feat(api): chat from the web's reads, Pause, End and Unlink, and the agent a folder belongs to, move onto the capability mount (DOR-4978)"
---

### Changed

- An agent that reads where chat from the web stands no longer sees your hub's address, this computer's name or when it was linked.
- Which browsers use this computer from the web is now yours alone to see: a program signed in with an API key is refused, as agents already were.
- An agent that looks up another agent by its folder no longer sees that agent's instructions, permissions, MCP servers or folder. Looking up itself is unchanged.
- From a Wi-Fi sign-in, Pause, End now and Unlink for chat from the web are still refused. The message now reads "Do this at this computer."
- The API document now lists `GET /api/agents/current`. Seven chat-from-the-web calls have new operation names, such as `session-relay.status` for `sessionRelay.getStatus`, so a client built from the document needs rebuilding.
