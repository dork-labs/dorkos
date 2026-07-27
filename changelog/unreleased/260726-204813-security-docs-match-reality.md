---
covers:
  - 'docs(security): say what DorkOS actually protects, and where each protection stops (DOR-509)'
---

### Changed

- Our own documentation described a few protections DorkOS does not have, and oversold some it does. The protections were never missing; the writing was wrong. Fixed:
  - **Three things an agent cannot take back, not one.** The docs said removing an installed package was the only action that stops and asks you. Deleting a scheduled task and removing an agent stop and ask too, and have since the permission gate was widened. One page even said an agent could delete a scheduled task without asking, which was the opposite of what happens.
  - **Bypass permissions does not turn everything off.** It skips the prompts inside a session, so an agent edits files and runs commands without stopping. The three actions above still wait for your answer.
  - **Tool group switches are guidance, not a lock.** Turning a group off changes what an agent is told about, so it stops reaching for those tools. It does not take the tools away. The pages that called this "controlling which tools an agent can access" now say what it does.
  - **Every protection now names the login it depends on.** With Require login off, which is how DorkOS starts, DorkOS refuses the agent that asked for something but cannot tell you apart from other software running as you on the same computer. With login on, only your signed-in account can answer. Both are real, and the docs used to state only the stronger one.
  - **"Secure by default" is gone.** In its place, the narrow claim that is actually true: DorkOS listens only on your own machine by default. We deliberately did not replace it with "sign-in required the moment you expose it", because that is not true of our Docker image: the image binds to every network address and switches off the guard that would otherwise refuse to start without a login, which our Docker guide already told you.
  - **Tool group switches are per-agent, but permission is not.** One thing genuinely is per-agent: a standing permission you grant from an approval card covers one agent doing one action, so two agents can meet the same gate and get different answers.
- The [Security page](https://dorkos.ai/security) has a new section on what an agent cannot do without asking you, including the limit, and the [Threat Model](https://dorkos.ai/docs/self-hosting/threat-model) now explains the three permission labels, where the approval gate sits, and the two ways traffic can reach DorkOS without passing the bind guard.
- The 0.8.0 release post carried the strongest version of the tool-switch claim. Rather than quietly rewrite a dated announcement, we left the wording and added a correction note at the top of it.
