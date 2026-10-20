---
covers:
  - 'feat: a chat started over Wi-Fi asks before every file or shell step (DOR-3037)'
  - 'fix: a Wi-Fi chat cannot raise permissions or outlive its cap (DOR-3037)'
  - "fix: Wi-Fi words never reach a turn at the agent's own level (DOR-3037)"
  - 'fix(client): on Wi-Fi a prompt offers no reason field, and a refused answer says why (DOR-3037)'
  - 'fix(client): on Wi-Fi the Add MCP server form says no up front (DOR-2969 part 3)'
  - 'fix(client): at phone width the Wi-Fi pill is its icon, so the chip stays readable (DOR-3037)'
  - 'fix(client): at phone width the permission chip says just its level beside the Wi-Fi icon (DOR-3037)'
  - 'fix(client): at phone width the permission chip always shows, and the Wi-Fi pill is easy to tap (DOR-3037)'
  - 'fix(client): Plan and the phone-width runtime icon hug their content on the status line (DOR-3037)'
  - "fix(server): the Wi-Fi refusals read the turn's marks after DOR-3036 part 1 (DOR-3037)"
  - 'refactor(server): reading a stored connected-app action joins its writer in approval-storable (DOR-3037)'
  - "fix(server): the Wi-Fi refusals read the turn's marks after DOR-3036 (DOR-3037)"
  - "test(server): Wi-Fi holds read through DOR-3107's sender bound and own circle (DOR-3037)"
---

### Security

- A chat you start or message from a phone or laptop on your Wi-Fi now runs at Default at most, even for an agent set to Full autonomy. The agent asks before every file change or command, and from Wi-Fi the answer is Allow once or Deny. The same limit follows anything that chat sets off: other agents it mentions or messages, chats it starts, a message waiting in line, and every turn that picks the chat up on its own: an approval's answer, a resume after a usage limit, a nudge after a sign-in. That holds even after DorkOS restarts. A schedule an agent makes during that chat waits for your approval, and the agent can't change its instructions or make a promise from it. An agent's check-ins skip messages written from Wi-Fi. (DOR-3037)
- From Wi-Fi you can lower permissions but not raise them. Picking Careful, blocking something, or setting a chat or schedule to ask more all work there. Loosening any of them, undoing a permission change, approving an agent's request that could change permissions, safety limits, packages, agents or tool servers, editing an agent's instructions (SOUL.md, NOPE.md, MEMORY.md, HEARTBEAT.md, persona, personality), recording an agent's promise, or running a schedule set above Default happens on the computer DorkOS runs on, and the app says so calmly. (DOR-3037)
- From Wi-Fi, answering a chat that runs above Default means picking one of the answers it offers. Typed answers, and a reason with any Deny, work only on the computer DorkOS runs on. (DOR-3037)
- On Wi-Fi the chat's status line says "On Wi-Fi · agents ask or only read", and the permissions chip shows "Default (Wi-Fi)". (DOR-3037)
