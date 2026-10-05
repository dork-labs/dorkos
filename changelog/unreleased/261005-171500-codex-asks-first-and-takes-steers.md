---
covers:
  - 'fix(codex): start fresh when a thread to reload never ran, and stop a lingering turn before forking (DOR-2719)'
  - 'feat(codex): turn app-server approvals, questions and elicitations into cards (DOR-2719)'
  - 'feat(codex): app-server modes ask first, with honest descriptors and capabilities (DOR-2719)'
  - 'feat(codex): steer a running app-server reply with turn/steer (DOR-2719)'
  - 'fix(codex): MCP approvals only on their own call, labelled elicitations verified, secret questions not drawn (DOR-2719)'
  - 'fix(codex): Ask first says read-only tools run unasked and approved steps reach further, proven on the binary (DOR-2719)'
---

### Added

- Codex can ask before it changes things, and you can steer it mid-reply, when the `runtimes.codex.transport` setting is `app-server` (DOR-2719). In Ask first, Codex asks before every change; it still runs read-only commands, and tools marked read-only, without asking. In Workspace write, it asks before it reaches outside your project or goes online. You approve or deny from a card in the chat. Questions Codex asks you, and forms from its tools, show up as cards too. A question that asks for a password or other secret is skipped for now, and the chat says so. A message you send while Codex is replying joins that reply instead of waiting for the next one. On `auto`, the default, Codex works exactly as before.

### Note for people upgrading

- If you set `runtimes.codex.transport` to `app-server`, a Codex chat in Ask first can now make changes. It still asks you first, every time. Before, it could only read. A chat can now start a Codex chat only from Full access, since every Codex level can reach your whole project.
