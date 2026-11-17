---
covers:
  - 'fix(auth): confirm the remaining lasting grants (DOR-4355, DOR-4595)'
  - "fix(auth): an agent's change to a task on credits asks first, and the mini app page links to its confirm (DOR-4609, DOR-4355)"
---

### Security

- Confirm with your DorkOS password before you install, update or link code, add a package source, apply a Shape, or run a workspace's setup commands.
- Confirm before you widen what agents may do with a connected app, save an app's key, connect or resume an account, or undo a narrowing.
- Confirm before a chat connection may do more, reach more chats or point at another agent, and before you add someone who may approve or message your agents there. Agents can no longer add those people.
- Confirm before a schedule runs with more permission, a space account is connected, a space may wake your agents more widely, an extension gets a secret, or a page gets a standing event route.
- When an agent changes a scheduled task that runs on DorkOS credits so it costs more (its prompt, its schedule, a longer time limit, or what it runs on), you get a card first, and nothing changes until you say yes. Lowering the limit, switching it off or moving it off credits still happens at once.
- Letting a mini app read a connected account now ends on its own page with a request code and an **Open DorkOS** button, so you can confirm it's you there and check the code matches.
