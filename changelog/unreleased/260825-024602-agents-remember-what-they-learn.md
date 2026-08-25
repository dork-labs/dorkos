---
covers:
  - 'fix(shared,server): notes trust their stamp, not their prose (DOR-632)'
  - 'fix(server,memory,shared): wave-3 review fixes (DOR-632)'
  - 'feat(memory,shared,server): agent-memory wave 1 — the engine package, the port, the fence primitive (DOR-632)'
  - 'feat(server): tell an agent it is one session of itself, on every runtime (DOR-632)'
  - 'fix(memory,shared): wave-1 review fixes (DOR-632)'
  - 'feat(shared,server): register MEMORY.md as a convention file everywhere (DOR-632)'
  - 'feat(server): inject <agent_memory> — fenced, honest, and out of the relaunch digest (DOR-632)'
  - 'feat(server): ship memory_write, with provenance the model cannot forge (DOR-632)'
  - 'feat(server): measure what each context block costs, at the shared builder (DOR-632)'
  - 'fix(server,memory,shared): wave-2 review fixes (DOR-632)'
  - 'fix(evals): the memory probes cannot lie about what they tested (DOR-632)'
  - 'fix(deps): the lockfile catches up with the memory package (DOR-632)'
  - 'fix(client,shared,server): the preview defuses what the fence defuses; prettier catches up (DOR-632)'
---

### Added

- Your agents remember what they learn. Every agent now keeps a short notes
  file of its own, beside its instructions and its boundaries. It reads those
  notes at the start of every conversation it joins, and writes down what is
  worth keeping. Tell an agent something in a private chat, and it still knows
  in a team channel next week (DOR-632)
- Every note the agent saves records where it learned it, like "(noted in
  #product, 2026-08-24)". The agent does not choose that part, so a note always
  says where it came from, and a note that turns out to be wrong tells you
  which conversation taught it (DOR-632)
- The notes file is plain markdown you can open in any editor, or from the
  agent's profile. Fix a line to correct it. Delete a line to forget it. It
  holds about 8,000 characters, which is small on purpose: the notes travel
  with every turn, so when the file fills up the agent is asked to tidy it
  rather than grow it (DOR-632)
- Anything in the notes file can come up in any conversation the agent joins,
  including channels with other people in them, so never put a secret in it.
  The file explains this rule at the top, and it is the only thing that crosses
  between conversations. The conversations themselves never do (DOR-632)
- Agents are now told the plain truth about how they run: each conversation is
  one session of the agent, sessions share the notes file but not the
  conversation, and an agent asked about work it cannot see should say so
  rather than guess. That last one is the difference between an agent that
  forgot and an agent that was never there (DOR-632)

### Changed

- Text somebody pastes into a room is neutralised a little more thoroughly
  before an agent reads it. DorkOS already wraps other people's messages in a
  marked-off block so an agent treats them as words rather than instructions,
  and a handful of DorkOS's own internal markers could previously survive inside
  that block. They no longer can. Nothing you type looks different and the same
  words reach the agent — they just cannot pretend to be part of DorkOS's own
  instructions any more (DOR-632)
- A note that quotes somebody else stays a quote. Every note records the
  conversation it was written in, and that stamp is written by DorkOS rather
  than by the agent — so a note saved in a busy channel cannot come back later
  claiming to be something you asked for. Only what you say in a direct chat
  sets your agent's standing preferences (DOR-632)
