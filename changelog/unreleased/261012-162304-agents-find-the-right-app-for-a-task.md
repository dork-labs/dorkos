---
covers:
  - 'feat(server): recommend tools take a plain task description and say what is already set up (DOR-2854)'
---

### Added

- Agents can now work out which app would help from a plain description of the job. Ask for something like "let the team know the deploy is done" and the agent can find that Slack or Telegram fits, and how to connect it (DOR-2854)
- When an agent suggests an app, it can now see whether you have already given it an account there. When it suggests a marketplace package, it can see whether that package is already installed. Either way, it won't ask you to set up something you already have (DOR-2854)
