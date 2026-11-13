---
covers:
  - "feat(server): an agent's chats claim work, so two never take the same job (DOR-4019)"
  - "fix(server): a claim list never shows a private chat's key (DOR-4019)"
---

### Added

- Let an agent's chats claim a job by name, like a ticket or a pull request, so its other chats see the job is taken and leave it. Starting a new chat on a job another chat holds is refused, naming the chat that has it. A claim ends when the chat lets it go or stops working for two hours. (DOR-4019)
