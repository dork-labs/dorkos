---
covers:
  - 'fix(server): the project .env file can’t change how DorkOS or its agents run (DOR-5481)'
---

### Changed

- The project `.env` file can't change how DorkOS or its agents run. Set what they need in the environment DorkOS starts in. `LOG_LEVEL` and `DO_NOT_TRACK` still work from that file.
- Your terminal in DorkOS and your workspace hooks no longer get variables from the project `.env` file. If a hook or a command in the terminal needs one, set it in the environment DorkOS starts in, for example in your shell profile.
- Your terminal and your workspace hooks no longer see DorkOS's own settings, such as its keys and tokens. That includes `GITHUB_TOKEN`, which DorkOS uses itself: if a command in the terminal needs it, have your shell set it. Everything else in the environment DorkOS starts in still reaches them.

### Note for people upgrading

- If you put a variable in the project `.env` file for your agents, your hooks or the DorkOS terminal, move it to the environment DorkOS starts in. Nothing in that file reaches them any more.
