---
covers:
  - 'feat(server,client): every runtime says what its models can do, not just OpenCode (DOR-1672)'
  - 'fix(server): close the re-pin drift gaps in the model capability claims (DOR-1672)'
  - 'fix(server): apply DOR-1672 adversarial-review findings'
---

### Changed

- Behind the scenes, Claude Code and Codex models now carry a stated answer to what they can do — use tools, take images, make pictures — instead of a blank. Only OpenCode models had one before. Nothing looks different in the app today, because the menu already treated a blank as "this model can do the job"; the answers are for what gets built on them next (DOR-1672)
