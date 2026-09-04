---
covers:
  - 'fix(server): Codex and OpenCode stop re-sending the DorkOS context every turn (DOR-477)'
---

### Fixed

- Long chats with Codex and OpenCode agents got slower and more expensive than they needed to be. Every turn re-sent the agent's whole introduction — who it is, its SOUL.md and NOPE.md, what DorkOS is, where it is running — and each copy stayed in the conversation, so a twenty-message chat was carrying twenty copies of the same few pages. OpenCode now sends it on a channel its own engine keeps out of the conversation, and Codex sends it once per chat and again only when you actually edit the agent. Measured on a real agent, that removes about 60% of the text a twenty-turn Codex chat was carrying and about 90% for OpenCode — counted as characters of text sent, which is what we can measure directly rather than what a model provider ends up charging for. Nothing an agent needs to know went away: its saved notes and the tools it currently has are still refreshed on every turn (DOR-477)
