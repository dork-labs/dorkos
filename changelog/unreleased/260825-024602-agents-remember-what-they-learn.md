---
covers:
  - 'feat(memory,shared,server): agent-memory wave 1 — the engine package, the port, the fence primitive (DOR-632)'
  - 'feat(server): tell an agent it is one session of itself, on every runtime (DOR-632)'
  - 'fix(memory,shared): wave-1 review fixes (DOR-632)'
  - 'feat(shared,server): register MEMORY.md as a convention file everywhere (DOR-632)'
  - 'feat(server): inject <agent_memory> — fenced, honest, and out of the relaunch digest (DOR-632)'
  - 'feat(server): ship memory_write, with provenance the model cannot forge (DOR-632)'
  - 'feat(server): measure what each context block costs, at the shared builder (DOR-632)'
---

### Added

- Your agents remember what they learn. Each agent now keeps a short notes file
  next to its other setup files, and it reads those notes at the start of every
  conversation it joins — a channel, a direct message, or a chat with you. When
  an agent learns something worth keeping, it writes it down, and every note
  records where it was learned. You can open the file and edit it yourself:
  change a line to correct it, delete a line to forget it.
- Agents are also told the plain truth about how they run: each conversation is
  one session of the agent, sessions share the notes file but not the
  conversation, and an agent asked about work it cannot see should say so rather
  than guess.
- Conversations themselves still never cross between rooms. The notes file is
  the only thing that does, it holds about 8,000 characters, and anything in it
  can come up in any conversation the agent joins — including channels with
  other people in them — so never put a secret in it.
