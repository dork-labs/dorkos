---
covers:
  - 'fix(connections): agents ask for apps by level, and every request says what happens next (DOR-2503)'
  - 'fix(connections): a request whose updates fail can still be answered, and ends on time (DOR-2503)'
  - 'fix(connections): taking an answer back stops its updates, and a new pick works (DOR-2503)'
  - 'fix(connections): a failed pick leaves your own updates exactly as they were (DOR-2503)'
  - 'fix(connections): a taken-back pick never moves an update backwards, and agents use your live updates as they are (DOR-2503)'
  - "fix(connections): a taken-back pick gives your own key's updates their own generation back (DOR-2503)"
---

### Changed

- An agent now asks for an app at one of the same two levels you answer with, Read or Read and write, instead of guessing the names of things it wants to do. So it's never told "you weren't allowed" right after you allowed exactly what it asked for
- You answer an agent's request with the same card everywhere: in the chat, in a room, and from Needs you on the Connections page. If the agent also wants to hear when something new happens there, the card asks you which updates it gets, right after you allow it
- Whatever happens to a request, the agent gets a plain note saying what comes next: still waiting on you, allowed, allowed only to read, turned down, or ran out of time. So it can tell you in its own words instead of guessing

### Fixed

- An agent can no longer open a new card for the same app just by rewording its reason. It keeps one open request per app, and it can't open requests faster than you could answer them
- If the updates you pick for an agent can't be set up, you can pick them again, answer without updates, or say no, instead of the request getting stuck. Updates you didn't end up allowing never arrive, and updates you'd already set up yourself are left exactly as they were. A request whose updates never start ends on time, and the agent is told it won't get updates
- On Codex and OpenCode, an agent waiting for your answer no longer gives up with an error while you’re still deciding
