---
covers:
  - 'feat(server,client): every runtime says what its models can do, not just OpenCode (DOR-1672)'
  - 'fix(server): close the re-pin drift gaps in the model capability claims (DOR-1672)'
---

### Changed

- Claude Code and Codex models now say what they can do: whether they can use tools, take images, and make pictures. Only OpenCode models did before. Nothing looks different in the app today, because the menu already read "no answer" as "this model can do the job" — what changes is that the answer is a stated fact for every runtime instead of a blank for two of them (DOR-1672)
