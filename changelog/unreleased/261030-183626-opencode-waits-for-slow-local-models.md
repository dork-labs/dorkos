---
covers:
  - 'fix(server): OpenCode turns wait for a slow local model instead of ending at 2 minutes (FB-68)'
---

### Fixed

- An OpenCode agent on a local model (such as Ollama) no longer gets cut off when its model takes more than 2 minutes to start answering. DorkOS used to read that wait as a turn that never started and end it with "the agent didn't start within 2 minutes". It now waits as long as the model is working. A tool that hangs is still stopped after 10 minutes. (FB-68)
