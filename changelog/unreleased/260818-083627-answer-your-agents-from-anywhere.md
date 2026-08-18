---
covers:
  - 'feat(shared): P3.1 — the Ask on the wire, reusing the pending-interaction DTO (DOR-1330)'
  - 'feat(server): P3.2 — the projector says when a session starts and stops waiting on a person (DOR-1330)'
  - 'feat(server): P3.3 — the Ask goes out on the global stream, with the room it came from (DOR-1330)'
  - 'feat(server): P3.4 — the list a window reads on mount, and a fail-closed bar on answering (DOR-1330)'
  - 'feat(client,shared,test-utils): P3.5 — both ends of the allowlist, and one way to ask what is waiting (DOR-1330)'
  - 'feat(client): P3.6 — one fleet-wide list of what is waiting, and Heads up stops guessing (DOR-1330)'
  - 'feat(client): P3.7 — one card family for every kind of Ask (DOR-1330)'
  - "feat(client): P3.8 — the Ask shows up in all five places, and the lane's amber rung goes live (DOR-1330)"
  - 'test(server): P3.9 — the authority table, the projector seam, the ledger and the ordering (DOR-1330)'
  - 'test(client,e2e): P3.10 — the store, the headline, the card, and answering from another route (DOR-1330)'
  - 'feat(client): P3.11 — the whole Ask family in the Dev Playground (DOR-1330)'
---

### Added

- When an agent stops to ask you something, you can now answer it from wherever you are in DorkOS. The question shows up in the header on every page, in the sidebar, on the home screen, and on the line above the message box in the channel it came from (DOR-1330)
- The question says what the agent actually wants, in its own words: "Meeting Notes wants to edit standup.md", not "waiting on you" (DOR-1330)
- Press `Cmd+Shift+Y` to jump to the next thing waiting on you. With the card in front of you, `A` allows it and `D` refuses it (DOR-1330)
- Several requests from one agent for the same tool arrive as one card, so five files to read is one decision and one Allow (DOR-1330)

### Changed

- Answer a question once and it is answered everywhere. Every copy of it turns into a line saying what happened: what you chose, or who answered it first and when, or that it is no longer needed (DOR-1330)
- The question still has ten minutes. If nobody answers in that time it is refused for you and the agent carries on without it, exactly as before. Showing it everywhere is how you get to it in time (DOR-1330)
- A question that arrives while you are typing never takes the cursor, and `A` is still just the letter A in your message (DOR-1330)

### Security

- An agent can never answer a question, including its own. Anything calling DorkOS as an agent is refused. With Require login turned on, so is anything holding one of your API keys, which is the kind of password a program uses instead of signing in. Only a person signed in on this machine can answer (DOR-1330)
- A channel still shows only a short note when an agent is waiting, with no file name, no command and no countdown. The question itself, with all of its detail, goes to this copy of DorkOS, where you are the person who can answer it (DOR-1330)
