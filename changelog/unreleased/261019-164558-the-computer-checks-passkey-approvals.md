---
covers:
  - 'feat(server): the computer issues and checks passkey-signed approvals (B4b)'
  - 'fix(server): web approvals allow only one-shot tools, take no deny reason, and record the counter once (B4b review)'
---

### Added

- Your computer can now check a passkey before it approves or denies a tool call from DorkOS on the web. It only acts when the passkey you added at this computer signed exactly that request, and only for a command, a web lookup or a file change outside settings folders. Anything else, and any reason for a denial, waits for you at the computer. Nothing changes in the app yet: adding a passkey comes next.
