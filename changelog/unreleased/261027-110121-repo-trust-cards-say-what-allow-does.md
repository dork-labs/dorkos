---
covers:
  - 'fix(server): repo trust cards ask what Allow does, and the badge says what a yes does (DOR-3359)'
  - 'fix(server): only the repo-pin cards may title themselves, and a long worktree name is cut in the middle (DOR-3359)'
  - 'fix(server): repo settings wait for a person below Full only (DOR-3298)'
  - 'fix(docs): close the folderConfigPinned row a merge split, and fold the seeded DOR-3298 fragments into one (DOR-3298)'
  - 'fix(server): a commit in between that changed a linked skill anywhere in the repo asks a person (DOR-3298)'
  - 'fix(server): a skill linked in from .agents no longer asks on every turn, and the repo card says what changed (DOR-3298)'
  - 'fix(server): a repo commit in between that touched .claude asks a person, and repo git reads skip your git config (DOR-3298)'
  - 'fix(server): agents can no longer change their own skills or commands (DOR-3068)'
  - "refactor(server): route the repo settings git reads through the safe runner's API (DOR-3298)"
  - "fix(server): close Security's five Musts on the repo settings check (DOR-3298)"
  - "fix(server): an agent can't approve its own hooks or MCP servers in a repo or worktree (DOR-3298)"
  - 'fix(server): a new agent whose folder runs anything waits for a person (DOR-3068)'
  - 'fix(server): held agent folder settings stop every setting that runs code, and the runtime (DOR-3068)'
  - "fix(server): close the pin's gaps: a renamed agent, plugin scripts, more settings that run code (DOR-3068)"
  - "fix(server): an agent can't change its own hooks, MCP servers or account without a person (DOR-3068)"
  - "fix(server): an agent's file tools can't rewrite an installed plugin (DOR-3068)"
---

### Changed

- When a repo's hooks or skills need your OK, the card now asks a plain question, like "Allow a changed skill in "my-app"?" or "Trust this repo's hooks and skills?". Its red label says what a yes does: "Runs code on this Mac" for hooks and settings, or "Widens what agents can run" for skills, subagents and commands.
