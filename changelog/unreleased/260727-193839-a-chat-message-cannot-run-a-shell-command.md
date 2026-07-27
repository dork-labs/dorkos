---
covers:
  - 'fix(runtimes): the approval gate closes on non-match, not opens (DOR-604)'
  - 'fix(relay): a binding nobody configured prompts instead of auto-accepting (DOR-604)'
  - 'fix(relay): a new Slack integration answers DMs by allowlist (DOR-604)'
  - 'fix(relay): only named approvers can authorize a tool call from chat (DOR-609)'
  - 'fix(relay): adapter config is validated before it is written (DOR-604)'
---

### Security

- A message from Slack or Telegram can no longer run a shell command on your
  machine without asking you. A chat message started an agent turn, that turn
  landed in a permission mode nobody had chosen, and in that mode every tool —
  including the one that runs shell commands — was approved automatically. Now
  anything that reaches DorkOS for a decision asks you first, whatever mode the
  turn is in. The one exception is "Bypass permissions", which is what that mode
  means and says (DOR-604)
- "Accept edits" now does what it always said it did: accept edits. It promised
  "auto-accept file edits; still prompt for other tools" and then approved
  everything, shell commands included. It also no longer waves through a file
  edit that tried to write outside the folder the agent was working in —
  something like your `~/.ssh` keys or your shell profile — which is exactly the
  case worth stopping to look at (DOR-604)
- Only people you name can approve a tool call from chat. When your agent asks
  permission to run something, it posts an Approve/Deny card into the
  conversation — and anyone who could see that card could press Approve,
  including the person whose message set the whole thing off. Now Slack and
  Telegram integrations each have an "Approvers" list, and only the people on it
  can answer. It starts empty, which means nothing gets approved from chat until
  you say who may — and it is deliberately a separate list from who can message
  your agent, because talking to it and letting it run a command on your machine
  are not the same permission (DOR-609)
- A new Slack integration only answers direct messages from people you name.
  It used to accept a DM from anyone in the workspace, and a DM starts an agent
  turn on your machine. Integrations you already set up keep working exactly as
  they did, and DorkOS now says so at startup if one of them is open to your
  whole workspace, so it stays your choice rather than an accident (DOR-604)

### Changed

- A chat integration binding that never had a permission mode picked for it now
  prompts, instead of quietly auto-accepting. Bindings you already configured
  keep the setting they had. If a channel of yours starts asking about shell
  commands it did not ask about before, that is this change, and you can set the
  binding to "Bypass permissions" if that channel is one you trust (DOR-604)
