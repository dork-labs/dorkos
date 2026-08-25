---
covers:
  - 'fix(server): an agent can no longer self-approve a scheduled task by calling the API without an agent header (DOR-1569)'
---

### Security

- With Require login turned on, only a person signed in to DorkOS can approve a scheduled task, turn off its safety prompts, or start one running. Before, anything holding one of your personal API keys counted as you for these — so a program on your machine could set up a task that runs on its own, at full power, without you ever seeing it. Approving a task now needs a real sign-in, the same bar DorkOS already uses for its other sensitive actions. Setting up tasks from the `dorkos` command line still works; a task it creates now waits for you to approve it in the app. (DOR-1569)
