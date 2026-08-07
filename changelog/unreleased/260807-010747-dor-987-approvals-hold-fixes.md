---
covers:
  - 'fix(server): a stranded capability hold no longer latches a session as blocked (DOR-987)'
  - 'fix(server): an approval hold never rejects or leaks its listener (DOR-987)'
  - 'fix(server): raise the approval hold cap to ten minutes and hold on every fresh ask (DOR-987)'
  - 'fix(client): keep the inline approval card as a note when the agent stops waiting (DOR-987)'
  - 'docs(server): name the hand-registered tools that still poll for approval (DOR-987)'
  - 'fix(server): floor an inherited MCP_TOOL_TIMEOUT that would cut approval holds short (DOR-987)'
  - 'test(server): split the capability-hold latch regression so each fix is pinned alone (DOR-987)'
  - 'docs: record the resolved MCP tool-call timeout verdict and fix approval-hold doc drift (DOR-987)'
---

### Fixed

- When an agent asks your OK for something it cannot undo, it now waits **ten minutes** for your
  answer instead of 45 seconds. Forty-five seconds was long enough to read the request and not
  much else, so stepping away almost always meant the agent had already given up by the time you
  said yes (DOR-987)
- If the agent does stop waiting, the request no longer disappears from the chat without a word.
  The card turns into a short note telling you it is still in your Approvals list and that
  answering it there is what you need to do (DOR-987)
- A chat could get stuck showing "waiting on you" forever. If a turn was interrupted while an
  agent was waiting for your OK, every later question in that chat looked unanswered even after
  you had answered it. Fixed (DOR-987)
- Retrying with an approval that had run out of time (or had already been used) used to put a
  request in your Approvals list and nowhere else — no card in the chat, and the agent did not
  wait for it. Those retries now show the card in the chat and wait, like the first request does
  (DOR-987)
