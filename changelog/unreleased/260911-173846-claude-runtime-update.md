---
covers:
  - 'fix(claude-code): keep the task and todo tools on after the SDK 0.3.268 bump'
  - 'fix(claude-code): surface account-hold, verification and cloud-credential errors'
  - 'feat(claude-code): send plugins over stdin and classify context rows by kind'
---

### Fixed

- Claude Code sessions keep showing their task list and to-dos after the runtime update
- You now get a clear message when your Claude account is on hold, needs verification, or its cloud credentials were refused, instead of a turn that just stops
- Sessions with a lot of plugins installed start reliably, including on Windows

### Changed

- The context meter counts every part of the conversation the runtime reports, so the number matches what the model actually sees
